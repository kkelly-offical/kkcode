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

// 与 check-import-cycles.mjs 同款的三种静态形态 + 动态 import("...")。
// 锚定行首避免把注释/字符串里的 import 字样当成真边；动态形态允许行首
// 有赋值与 await 前缀（`const { X } = await import("...")`）。
const IMPORT_FROM_RE = /^[ \t]*import\s+[\w${},\s*]+?\s+from\s*["']([^"']+)["']/gm
const SIDE_EFFECT_RE = /^[ \t]*import\s*["']([^"']+)["']/gm
const REEXPORT_RE = /^[ \t]*export\s+(?:\*\s+as\s+\w+|\*|\{[\w\s{},*]*?\})\s+from\s*["']([^"']+)["']/gm
const DYNAMIC_RE = /^[ \t]*(?:[\w{}$,\s*]+?=\s*)?(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/gm

/** 提取一份源码里全部 import/export-from 说明符（静态 + 动态字面量） */
export function parseBoundarySpecifiers(text) {
  const specs = []
  for (const re of [IMPORT_FROM_RE, SIDE_EFFECT_RE, REEXPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) specs.push(match[1])
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const json = process.argv.includes("--json")
  const { violations, unresolved } = await findBoundaryViolations(REPO_ROOT)
  if (json) {
    console.log(JSON.stringify({ violations, unresolved }, null, 2))
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
  }
  process.exit(violations.length ? 1 : 0)
}
