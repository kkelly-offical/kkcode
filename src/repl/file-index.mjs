/**
 * `@` 引用的候选来源：一份从 cwd 递归出来的相对路径清单。
 *
 * ## 三条不变量
 *
 * 1. **路径一律是 `/` 分隔的相对路径，Windows 上也是。** 排序、高亮区间、写回输入框、
 *    注入给模型的 `<file path="...">` 四处都用它做主键，只要有一处按平台变形，排序结果
 *    与高亮偏移就会在 Windows 上悄悄错位 —— 本项目已经在 Windows/POSIX 分歧上栽过四次
 *    （裸路径不是合法 ESM specifier、锁文件 EPERM vs EEXIST、路径分隔符、CRLF 切行）。
 *    所以拼接相对路径时**不走 `path.join`**，而是自己用 `/` 拼；只有拼给 fs 的绝对路径才
 *    交给注入进来的 `pathApi`。守着这条的测试喂的是 `path.win32` + 反斜杠形态的假 fs，
 *    因而**在 Linux 上也会红**。
 *
 * 2. **懒构建。** 第一次 `list()` 才走盘，之后吃缓存。补全是逐键触发的，每次按键遍历一遍
 *    仓库等于把输入框卡死。`refresh()` 是唯一的重建入口，且是同步、立即重建。
 *
 * 3. **封顶要说出来。** 超过 `maxFiles` 就停，并在 `stats().truncated` 上挂真值。悄悄封顶
 *    会让人以为「补全里没有就是仓库里没有」，然后花二十分钟找一个其实存在的文件。
 *
 * ## .gitignore 支持的子集
 *
 * 只读**仓库根**的那一份（不支持子目录里的 .gitignore、不支持 core.excludesFile、不支持
 * `.git/info/exclude`）。支持：注释与空行、`!` 反选（后匹配者胜）、前导 `/` 锚定、尾部 `/`
 * 限定目录、含 `/` 的模式锚定到根、`*` `?` `**` 通配与 `[...]` 字符类。编译不出来的模式
 * **跳过而不是崩** —— 一份看不懂的 .gitignore 不该让补全整个失灵。
 *
 * 与 git 的已知差异：不下钻被忽略的目录，所以无法用 `!` 把被忽略目录里的文件捞回来
 * （git 本身也是这个行为）；行首空白会被当作可忽略的缩进（git 不会）。
 *
 * ## 另一处已知边界
 *
 * 只提供 `statSync`（跟随链接）而不提供 `lstatSync` 的 fs 垫片上认不出符号链接，此时链接
 * 指向的目录会被当成普通子目录 —— 指回树内的靠 dev:ino 去重挡住，指向树外的会被索引进来。
 * `node:fs` 本身不在此列（它有 lstatSync，且 Dirent 直接报得出链接）。
 */

import nodeFs from "node:fs"
import nodePath from "node:path"

/** 任何一层里出现就整棵跳过的目录名。放在 .gitignore 规则**之前**，因而用户可以用 `!` 覆盖。 */
export const DEFAULT_IGNORE = [
  ".git", "node_modules", "dist", "build", "coverage",
  ".next", ".cache", "__pycache__", ".venv", "target"
]

export const DEFAULT_MAX_FILES = 20000

/** 递归深度上限。符号链接已经被跳过，这条是防「真的很深」与假 fs 造出来的环。 */
const DEFAULT_MAX_DEPTH = 32

/** 绝对路径 → `/` 分隔。只有 win32 形态需要换，POSIX 上文件名里的 `\` 是合法字符，别动它。 */
export function toPosixPath(value, pathApi = nodePath) {
  const text = String(value ?? "")
  return pathApi.sep === "\\" ? text.replace(/\\/g, "/") : text
}

const escapeLiteral = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * gitignore 通配 → 正则源码。`*` 不跨 `/`，`**` 跨。
 * 认不出的写法在这里尽量退化成字面量，真编译不了的由 compileIgnoreRule 兜底丢掉。
 */
function globToRegexSource(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` 吃掉零到多层目录；行尾的 `**` 吃掉剩下的一切
      const withSlash = glob[i + 2] === "/"
      out += withSlash ? "(?:.*/)?" : ".*"
      i += withSlash ? 2 : 1
      continue
    }
    if (ch === "*") { out += "[^/]*"; continue }
    if (ch === "?") { out += "[^/]"; continue }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 1)
      if (close < 0) { out += "\\["; continue }
      const body = glob.slice(i + 1, close)
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`
      i = close
      continue
    }
    if (ch === "\\" && i + 1 < glob.length) { out += escapeLiteral(glob[i + 1]); i++; continue }
    out += escapeLiteral(ch)
  }
  return out
}

/**
 * 一行 gitignore → 一条规则，认不出来返回 null（调用方丢掉，不抛）。
 *
 * `self` 匹配「路径本身就是它」，`under` 匹配「路径在它下面」—— 分成两条是因为尾部 `/`
 * 的模式只对目录本身生效，但它**下面的文件**无论如何都该被忽略。
 */
function compileIgnoreRule(raw) {
  let pattern = String(raw)
  const negate = pattern.startsWith("!")
  if (negate) pattern = pattern.slice(1)
  const dirOnly = pattern.endsWith("/")
  if (dirOnly) pattern = pattern.slice(0, -1)
  if (!pattern) return null
  // 含 `/` 即锚定到仓库根，这是 git 的语义：`a/b` 只匹配根下的 a/b，`b` 匹配任意层的 b
  const anchored = pattern.includes("/")
  if (pattern.startsWith("/")) pattern = pattern.slice(1)
  if (!pattern) return null
  const head = anchored ? "^" : "(?:^|/)"
  try {
    const source = globToRegexSource(pattern)
    return {
      raw: String(raw),
      negate,
      dirOnly,
      self: new RegExp(`${head}${source}$`),
      under: new RegExp(`${head}${source}/`)
    }
  } catch {
    return null
  }
}

/** 解析一整份 .gitignore。顺序保留 —— 后匹配的规则覆盖先匹配的。 */
export function parseGitignore(content) {
  const rules = []
  for (const line of String(content ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    // 尾部空白按 git 的规则丢掉（除非被反斜杠转义）；行首空白 git 会保留，这里从简
    const trimmed = line.replace(/^\s+/, "").replace(/(?<!\\)\s+$/, "")
    if (!trimmed || trimmed.startsWith("#")) continue
    const rule = compileIgnoreRule(trimmed)
    if (rule) rules.push(rule)
  }
  return rules
}

function ruleMatches(rule, relPath, isDir) {
  if (rule.under.test(relPath)) return true
  if (rule.dirOnly && !isDir) return false
  return rule.self.test(relPath)
}

/**
 * 组合默认清单与 .gitignore，返回 `(relPath, isDir) => boolean`。
 * 默认清单排在前面，所以 .gitignore 里的 `!dist` 之类能把它捞回来。
 */
export function createIgnoreMatcher({ names = DEFAULT_IGNORE, gitignore = "" } = {}) {
  const rules = [
    ...names.map((name) => compileIgnoreRule(`${name}/`)).filter(Boolean),
    ...parseGitignore(gitignore)
  ]
  return function isIgnored(relPath, isDir = false) {
    let ignored = false
    for (const rule of rules) {
      if (ruleMatches(rule, relPath, isDir)) ignored = !rule.negate
    }
    return ignored
  }
}

/**
 * 一条目录项 → `{ name, dir, file, id }`。
 *
 * `readdirSync(dir, { withFileTypes: true })` 正常会给 Dirent；注入进来的假 fs（以及很老的
 * 实现）可能忽略这个选项只给名字，那时退回 **lstat**。拿不到类型的项当作不存在，跳过。
 *
 * **符号链接在这里天然出局**：Dirent 与 lstat 都把它报成「既不是目录也不是文件」，于是它
 * 既不会被列进清单、也不会被下钻。所以这里**没有**一句显式的「跳过符号链接」—— 那句话在
 * 这两条路径上永远改变不了结果，是死代码。
 *
 * 只提供 `statSync`（跟随链接）的 fs 垫片是唯一的例外：那时链接看起来就是普通目录，认不出
 * 来，靠 `identityOf` 的 dev:ino 去重挡住环。
 */
function describeEntry(fs, pathApi, dir, entry) {
  if (entry && typeof entry.isDirectory === "function") {
    return { name: entry.name, dir: entry.isDirectory(), file: entry.isFile(), id: null }
  }
  const name = String(entry)
  const statOf = fs.lstatSync || fs.statSync
  try {
    const info = statOf.call(fs, pathApi.join(dir, name))
    return {
      name,
      dir: info.isDirectory(),
      file: typeof info.isFile === "function" ? info.isFile() : !info.isDirectory(),
      id: identityOf(info)
    }
  } catch {
    return null
  }
}

/**
 * 目录的真实身份 `dev:ino`，拿不到就是 null。
 *
 * 环不是只有符号链接一种造法：绑定挂载、`--bind`、Windows 的 junction 都能让两条路径指向
 * 同一个目录，而它们在 lstat 眼里都是**普通目录**。深度上限只能让遍历停下来，停下来之前
 * 已经把同一棵子树重复索引了几十遍。所以按身份去重：同一个真实目录只走一遍。
 */
function identityOf(info) {
  return info && info.ino != null && info.dev != null ? `${info.dev}:${info.ino}` : null
}

/**
 * 建一个索引。
 *
 * @param {object} options
 * @param {string} options.cwd      索引根
 * @param {object} options.fs       注入的 fs（需要 readdirSync / statSync / readFileSync）
 * @param {object} options.pathApi  注入的 path（测试喂 `path.win32` 来复现 Windows 形态）
 * @param {number} options.maxFiles 封顶，超了停并置 `stats().truncated`
 * @param {string[]} options.ignore 目录名黑名单，见 DEFAULT_IGNORE
 * @returns {{ refresh(): string[], list(): string[], stats(): object }}
 */
export function createFileIndex({
  cwd = process.cwd(),
  fs = nodeFs,
  pathApi = nodePath,
  maxFiles = DEFAULT_MAX_FILES,
  ignore = DEFAULT_IGNORE,
  maxDepth = DEFAULT_MAX_DEPTH
} = {}) {
  let cache = null
  let stats = { built: false, files: 0, dirs: 0, unreadable: 0, truncated: false, durationMs: 0, maxFiles }

  function readGitignore() {
    try {
      return fs.readFileSync(pathApi.join(cwd, ".gitignore"), "utf8")
    } catch {
      return ""
    }
  }

  function build() {
    const startedAt = Date.now()
    const isIgnored = createIgnoreMatcher({ names: ignore, gitignore: readGitignore() })
    const files = []
    const counts = { dirs: 0, unreadable: 0, truncated: false }
    const visited = new Set()
    try {
      const root = identityOf(fs.statSync(cwd))
      if (root) visited.add(root)
    } catch {
      // 根目录 stat 不了也照走：拿不到身份只是少一层防环，深度上限还在
    }

    function walk(absDir, prefix, depth) {
      if (counts.truncated || depth > maxDepth) return
      counts.dirs++
      let raw
      try {
        raw = fs.readdirSync(absDir, { withFileTypes: true })
      } catch {
        // 权限不足、竞态删除、坏挂载点：跳过这一层。一个读不了的目录不该让整份索引失败
        counts.unreadable++
        return
      }
      for (const item of raw) {
        const entry = describeEntry(fs, pathApi, absDir, item)
        if (!entry) continue
        // 相对路径**不用 pathApi.join** —— 见文件头第 1 条
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (isIgnored(rel, entry.dir)) continue
        if (entry.dir) {
          // 同一个真实目录只走一遍 —— 见 identityOf
          if (entry.id && visited.has(entry.id)) continue
          if (entry.id) visited.add(entry.id)
          walk(pathApi.join(absDir, entry.name), rel, depth + 1)
          if (counts.truncated) return
          continue
        }
        if (!entry.file) continue
        if (files.length >= maxFiles) { counts.truncated = true; return }
        files.push(rel)
      }
    }

    walk(cwd, "", 0)
    files.sort(comparePaths)
    stats = {
      built: true,
      files: files.length,
      dirs: counts.dirs,
      unreadable: counts.unreadable,
      truncated: counts.truncated,
      durationMs: Date.now() - startedAt,
      maxFiles
    }
    return files
  }

  return {
    /** 强制重建并返回新清单。唯一的失效入口 —— 别在按键路径上调它。 */
    refresh() {
      cache = build()
      return cache
    },
    /** 缓存优先；第一次调用才走盘。 */
    list() {
      if (!cache) cache = build()
      return cache
    },
    /** 每次返回一份拷贝，免得调用方改到内部状态。`truncated` 为真时清单是不全的。 */
    stats() {
      return { ...stats }
    }
  }
}

/** 路径排序：按码元比大小，不用 localeCompare —— 那个的结果随 locale 变，测试会飘。 */
export function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
