#!/usr/bin/env node
/**
 * 分层边界检查（1.0.0 阶段 4 落地 docs/architecture-kernel-sdk-1.0.0.md
 * §3 依赖规则与 §4.2.2 deep-import 禁令，CI 常驻）。
 *
 * 两条可机检规则：
 *
 *   1. frontends → kernel：src/repl.mjs、src/repl/、src/ui/、src/commands/、
 *      src/cli/ 只允许 import src/kernel/index.mjs（facade 白名单）；
 *      deep-import 内核内部文件即违规。静态 import、export-from、动态
 *      import("...")（字面量说明符）都算边。
 *   2. kernel → frontends：src/kernel/ 不得 import 任何 frontend 文件
 *      （含 src/theme/ 与 src/repl.mjs —— 层级倒置，M3 耦合点 13–15 的
 *      常驻防回归）。
 *   3. kernel 输出纪律（1.0.0 阶段 5，架构 §4.2.3，对照 Codex core 的
 *      deny(print_stdout)）：src/kernel/ 不得直写 stdout —— 禁止
 *      process.stdout.write(...) 与 console.log/info/debug/dir(...)。
 *      用户可见输出走 kernel.events / 宿主 handler；console.error/warn
 *      写 stderr，是 headless 契约的诊断通道，允许。eslint 的
 *      no-restricted-syntax 是同一规则的 AST 级兜底，两边任一命中都过不了 CI。
 *
 * 如实记录覆盖不到的地方，不假装检查了：
 *   - platform 层（src/config/、src/storage/ 等）与 kernel 之间仍有历史双向
 *     引用（如 config/defaults.mjs ↔ kernel/permission/file-edit-policy），
 *     §3 的 platform 规则要等后续阶段收敛，本脚本不检查该方向。
 *   - src/theme/ 在 §2 里属 frontends 层，但本阶段收敛范围不含它；它对
 *     kernel 的既有引用由规则 2 反向钉住（kernel 不依赖它），正向引用留待
 *     theme 自己的收敛任务。
 *   - test/ 不在检查范围：测试合法地 deep-import 内核内部（它们测的就是内部）。
 *
 * 用法：
 *   node scripts/check-boundaries.mjs          # 有违规 exit 1
 *   node scripts/check-boundaries.mjs --json   # 机器可读输出
 *
 * 同时作为库被 test/kernel-boundary.test.mjs 复用（边界归零防回归）。
 */
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

/** frontends 层的文件/目录前缀（相对仓库根，正斜杠） */
const FRONTEND_ROOTS = ["src/repl.mjs", "src/repl/", "src/ui/", "src/commands/", "src/cli/"]
/** kernel 目录前缀 */
const KERNEL_ROOT = "src/kernel/"
/** frontends 唯一可 import 的内核文件（facade 白名单，§4.2.2） */
const KERNEL_FACADE = "src/kernel/index.mjs"
/** 规则 2 里 kernel 不得依赖的 frontend 目标（theme 是 §2 明示的 frontends 层） */
const FRONTEND_TARGETS_FOR_KERNEL = [...FRONTEND_ROOTS, "src/theme/"]

// 与 check-import-cycles.mjs 同款的三种静态形态（行首锚定，避免把注释/字符串
// 里的 import 字样当成真边）+ 动态 import("...")。
// 动态形态**不做行首锚定**：`return await import(...)` / `if (x) await import(...)`
// 这类行中形态在锚定版本下整条逃逸（review round 1 P2-1 实测种植后脚本与
// eslint 均不报 —— eslint 10 的 no-restricted-imports 不覆盖 ImportExpression，
// 动态边只有这一道闸，不能留缝）。去锚的误报风险用两条护栏权衡：
//   1. 说明符必须 ./ ../ 开头才解析成边（findBoundaryViolations 里过滤），
//      文档/注释里的 import("...") 字样（非相对路径）天然不算；
//   2. 同一行内 match 之前出现 // 的判为行注释跳过；
//   3. match 之前未转义反引号数为奇数的判为在模板字符串（如 skill 内建文档
//      里的 markdown 示例）跳过 —— 实测 src/kernel/skill/builtin/frontend.mjs
//      的 Vue/React 路由示例会命中。
// 残留限定（如实记录）：块注释与非模板字符串字面量里的 import('../x') 仍会
// 误报；反过来，模板字符串 ${} 插值里的真动态 import 会被护栏 3 误跳（本仓库
// 不存在该形态）。误报 break lint 是可见的、误跳才是哑的，选择宁可见。
const IMPORT_FROM_RE = /^[ \t]*import\s+[\w${},\s*]+?\s+from\s*["']([^"']+)["']/gm
const SIDE_EFFECT_RE = /^[ \t]*import\s*["']([^"']+)["']/gm
const REEXPORT_RE = /^[ \t]*export\s+(?:\*\s+as\s+\w+|\*|\{[\w\s{},*]*?\})\s+from\s*["']([^"']+)["']/gm
const DYNAMIC_RE = /(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/g

/** 未转义反引号计数为奇数 = 位置在模板字符串内（` 与 \` 成对出现才算进出） */
function insideTemplateLiteral(text, index) {
  let count = 0
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "`" && text[i - 1] !== "\\") count += 1
  }
  return count % 2 === 1
}

/** 提取一份源码里全部 import/export-from 说明符（静态 + 动态字面量） */
export function parseBoundarySpecifiers(text) {
  const specs = []
  for (const re of [IMPORT_FROM_RE, SIDE_EFFECT_RE, REEXPORT_RE]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) specs.push(match[1])
  }
  DYNAMIC_RE.lastIndex = 0
  for (const match of text.matchAll(DYNAMIC_RE)) {
    // 行注释护栏：match 所在行、match 之前已有 // 的，是注释里的字样不是真边
    const lineStart = text.lastIndexOf("\n", match.index) + 1
    if (text.slice(lineStart, match.index).includes("//")) continue
    // 模板字符串护栏：文档/示例文本里的 import() 不是真边
    if (insideTemplateLiteral(text, match.index)) continue
    specs.push(match[1])
  }
  return specs
}

async function collectSourceFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectSourceFiles(full, acc)
    else if (entry.isFile() && entry.name.endsWith(".mjs")) acc.push(full)
  }
  return acc
}

/** 归一化成仓库根相对的正斜杠路径（Windows 上 path.relative 产反斜杠） */
function toRel(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join("/")
}

function hasRootPrefix(relFile, roots) {
  return roots.some((root) => root.endsWith("/") ? relFile.startsWith(root) : relFile === root)
}

/**
 * 扫描并返回全部边界违规边。
 * @param {string} [repoRoot]
 * @returns {Promise<{ violations: Array<{ from: string, to: string, rule: string }>, unresolved: Array<{ from: string, spec: string }> }>}
 */
export async function findBoundaryViolations(repoRoot = REPO_ROOT) {
  const violations = []
  const unresolved = []
  const files = (await collectSourceFiles(path.join(repoRoot, "src"))).sort()
  for (const file of files) {
    const relFrom = toRel(repoRoot, file)
    const isFrontend = hasRootPrefix(relFrom, FRONTEND_ROOTS)
    const isKernel = relFrom.startsWith(KERNEL_ROOT)
    if (!isFrontend && !isKernel) continue
    const text = await readFile(file, "utf8")
    for (const spec of parseBoundarySpecifiers(text)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue
      const base = path.resolve(path.dirname(file), spec)
      const candidates = path.extname(base) ? [base] : [`${base}.mjs`, path.join(base, "index.mjs")]
      let resolved = null
      for (const candidate of candidates) {
        try {
          await readFile(candidate)
          resolved = candidate
          break
        } catch {
          // 尝试下一个候选
        }
      }
      if (resolved === null) {
        unresolved.push({ from: relFrom, spec })
        continue
      }
      const relTo = toRel(repoRoot, resolved)
      if (isFrontend && relTo.startsWith(KERNEL_ROOT) && relTo !== KERNEL_FACADE) {
        violations.push({ from: relFrom, to: relTo, rule: "frontends->kernel-internal" })
      }
      if (isKernel && hasRootPrefix(relTo, FRONTEND_TARGETS_FOR_KERNEL)) {
        violations.push({ from: relFrom, to: relTo, rule: "kernel->frontends" })
      }
    }
  }
  return { violations, unresolved }
}

/**
 * 规则 3：kernel 输出纪律（架构 §4.2.3）。扫描 src/kernel/ 下直写 stdout 的调用：
 *   - process.stdout.write(...)
 *   - console.log / info / debug / dir(...)（这四个都写 stdout）
 * console.error/warn 写 stderr，是 headless 契约（docs/headless-jsonl-contract.md）
 * 的诊断通道，明确允许；process.stdout.isTTY 这类**读取**不是写，不算违规。
 *
 * 护栏与 import 扫描同款：行注释（match 之前同行已有 //）与模板字符串
 * （未转义反引号奇数）里的字样不算。残留限定（如实记录）：块注释与普通
 * 字符串字面量里的 "console.log(" 仍会误报 —— 误报 break lint 是可见的，
 * 选择宁可见；内核现状（含 builtin-hooks/console-warn.mjs 的提示文案，
 * 无调用括号）不触发。
 *
 * @param {string} [repoRoot]
 * @returns {Promise<Array<{ file: string, line: number, match: string, rule: string }>>}
 */
export async function findKernelStdoutViolations(repoRoot = REPO_ROOT) {
  const STDOUT_WRITE_RES = [
    /\bprocess\.stdout\.write\s*\(/g,
    /\bconsole\.(?:log|info|debug|dir)\s*\(/g
  ]
  const violations = []
  const kernelDir = path.join(repoRoot, "src", "kernel")
  const files = (await collectSourceFiles(kernelDir)).sort()
  for (const file of files) {
    const text = await readFile(file, "utf8")
    const found = []
    for (const re of STDOUT_WRITE_RES) {
      re.lastIndex = 0
      for (const match of text.matchAll(re)) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1
        if (text.slice(lineStart, match.index).includes("//")) continue
        if (insideTemplateLiteral(text, match.index)) continue
        const line = text.slice(0, match.index).split("\n").length
        found.push({
          file: toRel(repoRoot, file),
          line,
          column: match.index - lineStart + 1,
          match: match[0].replace(/\s*\($/, ""),
          rule: "kernel-stdout-discipline"
        })
      }
    }
    // 报告按源码位置排序（扫描顺序是模式优先，不是位置优先）
    found.sort((a, b) => a.line - b.line || a.column - b.column)
    violations.push(...found)
  }
  return violations
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const json = process.argv.includes("--json")
  const { violations, unresolved } = await findBoundaryViolations(REPO_ROOT)
  const stdoutViolations = await findKernelStdoutViolations(REPO_ROOT)
  if (json) {
    console.log(JSON.stringify({ violations, unresolved, stdoutViolations }, null, 2))
  } else {
    if (unresolved.length) {
      console.log(`warning: ${unresolved.length} relative import(s) could not be resolved (boundary graph may be incomplete):`)
      for (const u of unresolved) console.log(`  ${u.from} -> "${u.spec}"`)
    }
    if (violations.length === 0) {
      console.log("boundary check: 0 frontends->kernel internal import edge(s); 0 kernel->frontends edge(s)")
    } else {
      for (const v of violations) console.log(`  [${v.rule}] ${v.from} -> ${v.to}`)
      console.log(`\n${violations.length} boundary violation(s) — frontends 只允许 import src/kernel/index.mjs（架构 §4.2.2）`)
    }
    if (stdoutViolations.length === 0) {
      console.log("kernel stdout discipline: 0 direct stdout write(s) under src/kernel/（架构 §4.2.3）")
    } else {
      for (const v of stdoutViolations) console.log(`  [${v.rule}] ${v.file}:${v.line} ${v.match}`)
      console.log(`\n${stdoutViolations.length} kernel stdout violation(s) — kernel 不得直写 stdout；用户可见输出走 kernel.events（架构 §4.2.3，docs/headless-jsonl-contract.md）`)
    }
  }
  process.exit(violations.length || stdoutViolations.length ? 1 : 0)
}
