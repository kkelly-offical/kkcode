/**
 * `@` 引用任意文件：词法、写回、提交时展开。
 *
 * ## 与既有图片链路的关系（读这一段再改代码）
 *
 * 在此之前 `@` 在本项目里**只有一个语义**：`src/tool/image-util.mjs` 的 `extractImageRefs`
 * 把 `@shot.png` 抽成图片附件，并**从文本里删掉**这个引用。那条链路必须原样活着。
 *
 * 所以这里的规矩是：**图片扩展名一律不碰**。`expandFileMentions` 见到 `@a.png` 直接跳过，
 * 留给 `extractImageRefs`；判断用的是从 image-util 里 import 的 `isImagePath`，**不在这里
 * 重写一份扩展名清单** —— 本项目为此吃过亏：那份清单曾经有两份手写拷贝，一份有 `.ico`
 * 另一份没有，于是同一个文件在两个入口是两种东西。
 *
 * 两者的顺序在集成方那里是：先 `expandFileMentions`（只追加引用块、不改原句），再
 * `extractImageRefs`（抽图片并删引用）。反过来也行，因为两者处理的 token 集合不相交。
 *
 * ## 三个入口的分工
 *
 * - `mentionQueryAt(text, cursor)`：光标处正在输入哪个 `@token`，给补全菜单用。
 * - `applyMention(text, cursor, path)`：把那个 token 整体换成选中的路径。
 * - `expandFileMentions(text, opts)`：提交时把引用到的文件内容追加到消息末尾。
 *
 * 前两个是纯字符串函数、不碰 fs；只有第三个走盘。这条边界让「输入时的行为」可以被完全
 * 确定地测出来，而不需要造一个假文件系统。
 */

import nodeFs from "node:fs"
import nodePath from "node:path"
import { isImagePath, normalizeDroppedPath } from "../tool/image-util.mjs"
import { toPosixPath, comparePaths } from "./file-index.mjs"

export { createFileIndex, createIgnoreMatcher, parseGitignore, DEFAULT_IGNORE, DEFAULT_MAX_FILES } from "./file-index.mjs"
export { rankCandidates } from "./file-rank.mjs"

export const DEFAULT_MAX_TOTAL_BYTES = 200_000
export const DEFAULT_MAX_FILE_BYTES = 60_000

/** 单个文件读进内存的硬上限。比这更大的直接跳过，不读 —— 否则一个 2GB 的日志能把进程撑爆。 */
const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024

/** 目录展开时最多列几条。列表是给模型看「这里有什么」，不是给它读完的。 */
const DEFAULT_MAX_DIR_ENTRIES = 100

/** 按扩展名就能判定的二进制，省得先读进来再看有没有 NUL。图片不在这里 —— 它们走图片链路。 */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".o", ".a",
  ".class", ".jar", ".wasm", ".node", ".pyc", ".pyo",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".db", ".sqlite", ".sqlite3"
])

const isWhitespace = (ch) => ch !== undefined && /\s/.test(ch)

/** 引号内的部分：到收尾引号或行尾为止。未闭合也要能用 —— 用户正在打字的中途就是未闭合的。 */
function readQuoted(source, from) {
  let i = from
  while (i < source.length && source[i] !== "\"" && source[i] !== "\n") i++
  return { value: source.slice(from, i), end: source[i] === "\"" ? i + 1 : i }
}

/**
 * 从 `@` 处读出一个 token。
 * 支持 `@"a b/c.ts"` 与 `@a\ b.ts` 两种带空格的写法 —— 前者是终端拖拽给的形态，
 * 后者是 shell 补全给的形态，两种都得认，否则带空格的路径根本没法引用。
 */
function readToken(source, at) {
  if (source[at + 1] === "\"") {
    const quoted = readQuoted(source, at + 2)
    return { start: at, end: quoted.end, query: quoted.value, quoted: true }
  }
  let i = at + 1
  let value = ""
  while (i < source.length) {
    const ch = source[i]
    if (ch === "\\" && source[i + 1] === " ") { value += " "; i += 2; continue }
    if (isWhitespace(ch)) break
    value += ch
    i++
  }
  return { start: at, end: i, query: value, quoted: false }
}

/**
 * 文本里所有处于词边界的 `@token`，按出现顺序。
 *
 * 「词边界」= 行首或前面是空白。这一条把 `a@b.com`（邮箱）挡在外面 —— 否则每封贴进来的
 * 邮件地址都会变成一次文件查找。`@` 在句中但前面是标点（`(@foo`）同样不算，宁可漏认。
 *
 * @returns {Array<{start: number, end: number, query: string, quoted: boolean}>}
 *          `text.slice(start, end)` 就是 token 原文；query 是去掉 `@`、引号与 `\ ` 转义后的查询串。
 */
export function scanMentions(text) {
  const source = String(text ?? "")
  const out = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "@") continue
    if (i > 0 && !isWhitespace(source[i - 1])) continue
    const token = readToken(source, i)
    out.push(token)
    i = Math.max(i, token.end - 1)
  }
  return out
}

/**
 * 光标落在某个 `@token` 内部或右端时返回它，否则 null。
 *
 * 命中区间是 `[start + 1, end]`：光标停在 `@` **左侧**不算（那时用户还没开始写这个引用），
 * 停在 token 右端算（那是最常见的位置 —— 刚打完还在继续打）。刚敲下 `@` 时 query 是空串，
 * 这是合法状态，菜单应当把「前 N 个文件」列出来。
 *
 * `query` 始终是**整个 token** 的载荷，与光标停在 token 内的哪一格无关。因为 `applyMention`
 * 替换的也是整个 token —— 筛选看的东西和被替换掉的东西必须是同一个，否则会出现「菜单里
 * 明明选中了它，回车后却变成另一个」。要按光标前缀筛的话在调用方 `slice` 一下即可。
 *
 * 与 `slash-router.mjs` 的 `commandQuery` 是同一类东西，区别是那个只看行首、这个看光标。
 *
 * @returns {{query: string, start: number, end: number} | null}
 */
export function mentionQueryAt(text, cursor) {
  const source = String(text ?? "")
  const at = clampCursor(source, cursor)
  for (const token of scanMentions(source)) {
    if (at >= token.start + 1 && at <= token.end) {
      return { query: token.query, start: token.start, end: token.end }
    }
  }
  return null
}

function clampCursor(source, cursor) {
  const value = Number(cursor)
  if (!Number.isFinite(value)) return source.length
  return Math.max(0, Math.min(source.length, Math.floor(value)))
}

/**
 * 路径 → 写进输入框的形态。
 *
 * 含空格时包引号；路径本身含引号时改用反斜杠转义空格 —— 因为 `readQuoted` 在第一个引号
 * 处就收尾，包起来会被读回成半截路径。**格式化与解析必须互为逆运算**，测试里有一条往返。
 */
export function formatMentionPath(candidate) {
  const value = String(candidate ?? "")
  if (!/\s/.test(value)) return value
  if (value.includes("\"")) return value.replace(/ /g, "\\ ")
  return `"${value}"`
}

/**
 * 把光标处的 mention **整体替换**成 `@<path>`，光标停在其后的空格之后。
 *
 * 「整体替换」是要点：用户敲了 `@rep` 再选中 `src/repl.mjs`，结果必须是 `@src/repl.mjs`
 * 而不是 `@repsrc/repl.mjs`。写回风格与 `slash-router.mjs` 的 `applySuggestionToInput`
 * 一致 —— 后面已经有空白就不再补一个，免得每次补全都长出一串空格。
 *
 * @returns {{text: string, cursor: number}} 光标不在 mention 上时原样返回。
 */
export function applyMention(text, cursor, candidatePath) {
  const source = String(text ?? "")
  const hit = mentionQueryAt(source, cursor)
  if (!hit) return { text: source, cursor: clampCursor(source, cursor) }
  const marker = `@${formatMentionPath(candidatePath)}`
  const rest = source.slice(hit.end)
  const hasSpace = rest.startsWith(" ") || rest.startsWith("\t")
  // 行尾（`\n`）不补空格，否则每次补全都在行末留一个看不见的尾巴
  const trailing = isWhitespace(rest[0]) ? "" : " "
  return {
    text: source.slice(0, hit.start) + marker + trailing + rest,
    cursor: hit.start + marker.length + (hasSpace || trailing ? 1 : 0)
  }
}

const isUrlRef = (ref) => /^[a-z][a-z0-9+.\-]*:\/\//i.test(ref)

/** 提交时要展开的引用：跳过空的、URL、以及图片（后者留给 extractImageRefs）。 */
function collectFileRefs(source) {
  const refs = []
  const seen = new Set()
  for (const token of scanMentions(source)) {
    const ref = token.query
    if (!ref || seen.has(ref) || isUrlRef(ref) || isImagePath(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }
  return refs
}

/** `<file path="...">` 里的属性值。路径里出现引号会把块结构撑破，转义掉。 */
const escapeAttr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")

/** 在 cwd 之内就显示成 `/` 分隔的相对路径，之外就用用户原本写的那个串。 */
function displayPath(abs, ref, cwd, pathApi) {
  const rel = pathApi.relative(cwd, abs)
  if (!rel || rel.startsWith("..") || pathApi.isAbsolute(rel)) return ref
  return toPosixPath(rel, pathApi)
}

/**
 * 一个引用 → 它指向什么。
 * 不存在返回 `{ kind: "missing" }`，读不了返回 `{ kind: "unreadable" }` —— 两者都不抛。
 */
function describeTarget(ref, ctx) {
  const normalized = normalizeDroppedPath(ref)
  const abs = ctx.pathApi.resolve(ctx.cwd, normalized)
  const display = displayPath(abs, ref, ctx.cwd, ctx.pathApi)
  if (!ctx.fs.existsSync(abs)) return { kind: "missing", abs, display, ref }
  try {
    const info = ctx.fs.statSync(abs)
    return { kind: info.isDirectory() ? "dir" : "file", abs, display, ref, size: Number(info.size) || 0 }
  } catch {
    return { kind: "unreadable", abs, display, ref }
  }
}

/** 目录 → 一层列表。列内容而不是列文件的内容：一个 node_modules 能把整个上下文吃光。 */
function renderDirBlock(target, ctx) {
  let raw
  try {
    raw = ctx.fs.readdirSync(target.abs, { withFileTypes: true })
  } catch {
    return { skipped: "unreadable" }
  }
  const names = raw.map((item) => (typeof item.isDirectory === "function"
    ? `${item.name}${item.isDirectory() ? "/" : ""}`
    : String(item)))
  names.sort(comparePaths)
  const shown = names.slice(0, ctx.maxDirEntries)
  const omitted = names.length - shown.length
  const lines = [...shown]
  if (omitted > 0) lines.push(`… [${omitted} more entries omitted]`)
  const body = lines.join("\n")
  return {
    block: `<dir path="${escapeAttr(target.display)}" entries="${names.length}">\n${body}\n</dir>`,
    bytes: Buffer.byteLength(body),
    truncated: omitted > 0
  }
}

/** 二进制判定：先看扩展名（不用读盘），再看前 8KB 里有没有 NUL。 */
function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0)
}

/** 截断点尽量落在行边界上，这样块里不会出现半行；顺带也就不会把多字节字符切成两半。 */
function cutAt(buffer, limit) {
  const newline = buffer.subarray(0, limit).lastIndexOf(0x0a)
  return newline > limit / 2 ? newline + 1 : limit
}

function renderFileBlock(target, ctx) {
  if (BINARY_EXTENSIONS.has(ctx.pathApi.extname(target.abs).toLowerCase())) {
    return { skipped: "binary" }
  }
  if (target.size > ctx.maxReadBytes) return { skipped: "too-large" }
  let buffer
  try {
    buffer = ctx.fs.readFileSync(target.abs)
  } catch {
    return { skipped: "unreadable" }
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), "utf8")
  if (looksBinary(bytes)) return { skipped: "binary" }
  const truncated = bytes.length > ctx.maxFileBytes
  const end = truncated ? cutAt(bytes, ctx.maxFileBytes) : bytes.length
  const body = bytes.subarray(0, end).toString("utf8")
  const note = truncated ? `\n… [truncated: ${bytes.length - end} more bytes omitted]` : ""
  return {
    block: `<file path="${escapeAttr(target.display)}">\n${body}${note}\n</file>`,
    bytes: end,
    truncated
  }
}

/**
 * 提交时展开 `@路径`。
 *
 * **原句一个字都不改** —— `@src/foo.ts` 原样留在那里，内容统一追加在消息末尾。这样模型
 * 既知道你在句子的哪个位置提到了它，又拿得到内容；而删改原句的话，用户看到的历史记录会
 * 和他打出去的那句话对不上。
 *
 * 没有任何可展开的引用时**返回原字符串**，不做任何拼接、不折叠空白、不 trim。绝大多数回合
 * 不带引用，那条路径必须是零开销、零副作用的。
 *
 * @param {string} text
 * @param {object} options
 * @param {string} options.cwd
 * @param {object} options.fs             需要 existsSync / statSync / readFileSync / readdirSync（同步接口，
 *                                        与 createFileIndex 用同一份假 fs 就能测）
 * @param {number} options.maxTotalBytes  所有引用加起来的上限，到顶后停止追加，剩下的进 skipped
 * @param {number} options.maxFileBytes   单个文件的上限，超了截断并在块里注明少了多少字节
 * @returns {Promise<{text: string, attached: Array, missing: Array, skipped: Array}>}
 */
export async function expandFileMentions(text, {
  cwd = process.cwd(),
  fs = nodeFs,
  pathApi = nodePath,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  maxDirEntries = DEFAULT_MAX_DIR_ENTRIES
} = {}) {
  const source = String(text ?? "")
  const refs = collectFileRefs(source)
  if (!refs.length) return { text: source, attached: [], missing: [], skipped: [] }

  const ctx = { cwd, fs, pathApi, maxFileBytes, maxReadBytes, maxDirEntries }
  const attached = []
  const missing = []
  const skipped = []
  const blocks = []
  const seen = new Set()
  let used = 0
  let stopped = false

  for (const ref of refs) {
    const target = describeTarget(ref, ctx)
    if (target.kind === "missing") { missing.push({ path: target.display, ref }); continue }
    // 同一个文件写两遍（`@src/a.ts` 与 `@./src/a.ts`）只注入一次
    if (seen.has(target.abs)) continue
    seen.add(target.abs)
    if (target.kind === "unreadable") { skipped.push({ path: target.display, ref, reason: "unreadable" }); continue }
    if (stopped) { skipped.push({ path: target.display, ref, reason: "total-budget" }); continue }

    const rendered = target.kind === "dir" ? renderDirBlock(target, ctx) : renderFileBlock(target, ctx)
    if (rendered.skipped) { skipped.push({ path: target.display, ref, reason: rendered.skipped }); continue }
    const cost = Buffer.byteLength(rendered.block)
    if (used + cost > maxTotalBytes) {
      // 到顶就整个停下，后面的一律进 skipped —— 「装到一半」比「明确没装」更难排查
      stopped = true
      skipped.push({ path: target.display, ref, reason: "total-budget" })
      continue
    }
    used += cost
    blocks.push(rendered.block)
    attached.push({ path: target.display, kind: target.kind, bytes: rendered.bytes, truncated: rendered.truncated })
  }

  return {
    text: blocks.length ? `${source}\n\n${blocks.join("\n\n")}` : source,
    attached,
    missing,
    skipped
  }
}
