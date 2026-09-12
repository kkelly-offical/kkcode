#!/usr/bin/env node
/**
 * 静态 import 环检测器（M3 §四.1 同款 Tarjan SCC，1.0.0 阶段 1b 起常驻）。
 *
 * 扫描 src 下全部 .mjs 的静态 import / export-from 边，把相对路径解析成
 * 文件后跑 Tarjan 强连通分量，≥2 个文件的 SCC 就是「环」（含单文件自 import）。
 * 动态 import() 刻意不算边：它不参与模块求值期拓扑，而且破环纪律明确禁止
 * 拿它糊弄（docs/architecture-kernel-sdk-1.0.0.md §6 阶段 1b / §7.1）。
 *
 * 用法：
 *   node scripts/check-import-cycles.mjs                      # 扫描 src/，有环 exit 1
 *   node scripts/check-import-cycles.mjs --root src           # 指定扫描根
 *   node scripts/check-import-cycles.mjs --only src/session/  # 只报告触及该前缀的环
 *   node scripts/check-import-cycles.mjs --json               # 机器可读输出
 *
 * 同时作为库被 test/session-import-cycle.test.mjs 复用（session/ 无环防回归）。
 */
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

// 静态 import 的三种形态。锚定行首、子句字符集限定为标识符/花括号/逗号/星号，
// 避免把注释或字符串里的 "import" 字样当成真边。`import\s` 要求空白，动态
// import() 天然不匹配。
const IMPORT_FROM_RE = /^[ \t]*import\s+[\w${},\s*]+?\s+from\s*["']([^"']+)["']/gm
const SIDE_EFFECT_RE = /^[ \t]*import\s*["']([^"']+)["']/gm
const REEXPORT_RE = /^[ \t]*export\s+(?:\*\s+as\s+\w+|\*|\{[\w\s{},*]*?\})\s+from\s*["']([^"']+)["']/gm

/** 提取一份源码里的全部静态 import/export-from 说明符 */
export function parseSpecifiers(text) {
  const specs = []
  for (const re of [IMPORT_FROM_RE, SIDE_EFFECT_RE, REEXPORT_RE]) {
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

/**
 * 把 import 说明符解析成文件绝对路径。
 * 返回 null = 外部依赖（node: 内置 / 裸包名），不构成文件级边；
 * 返回 undefined = 相对路径但解析不到文件（调用方应记录，防止漏边造成假绿）。
 */
async function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = path.extname(base) ? [base] : [`${base}.mjs`, path.join(base, "index.mjs")]
  for (const candidate of candidates) {
    try {
      await readFile(candidate)
      return candidate
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined
}

/**
 * 构建文件级 import 图。
 * @returns {{ files: string[], edges: Map<string, Set<string>>, unresolved: Array<{ from: string, spec: string }> }}
 */
export async function collectImportGraph(rootDir) {
  const files = (await collectSourceFiles(path.resolve(rootDir))).sort()
  const edges = new Map()
  const unresolved = []
  for (const file of files) {
    const text = await readFile(file, "utf8")
    const targets = new Set()
    for (const spec of parseSpecifiers(text)) {
      const resolved = await resolveSpecifier(file, spec)
      if (resolved === null) continue
      if (resolved === undefined) {
        unresolved.push({ from: file, spec })
        continue
      }
      targets.add(resolved)
    }
    edges.set(file, targets)
  }
  return { files, edges, unresolved }
}

/**
 * Tarjan SCC。返回成员数 ≥2 的分量，以及带自环边的单文件分量。
 * @param {Map<string, Set<string>>} edges
 * @returns {string[][]} 每个分量内部按路径排序
 */
export function findSccs(edges) {
  let index = 0
  const stack = []
  const onStack = new Set()
  const indices = new Map()
  const low = new Map()
  const sccs = []

  function strongconnect(v) {
    indices.set(v, index)
    low.set(v, index)
    index += 1
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) || []) {
      if (!edges.has(w)) continue // 指向扫描根之外的文件（--root 裁剪时）
      if (!indices.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)))
      }
    }
    if (low.get(v) === indices.get(v)) {
      const scc = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      if (scc.length > 1 || (edges.get(v) || new Set()).has(v)) sccs.push(scc.sort())
    }
  }

  for (const v of edges.keys()) {
    if (!indices.has(v)) strongconnect(v)
  }
  return sccs
}

/** 在 SCC 内部找一条具体的闭环路径，让报告可直接对照代码核查 */
function witnessCycle(members, edges) {
  const inScc = new Set(members)
  const start = members[0]
  if (members.length === 1) return [start, start]
  const trail = [start]
  const visited = new Set([start])
  function dfs(node) {
    for (const next of edges.get(node) || []) {
      if (!inScc.has(next)) continue
      if (next === start) return true
      if (visited.has(next)) continue
      visited.add(next)
      trail.push(next)
      if (dfs(next)) return true
      trail.pop()
    }
    return false
  }
  dfs(start)
  trail.push(start)
  return trail
}

/** 一站式：扫描 rootDir 并返回 SCC 清单 */
export async function findImportCycles(rootDir) {
  const { edges } = await collectImportGraph(rootDir)
  return findSccs(edges)
}

function parseArgs(argv) {
  const options = { root: "src", only: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") options.root = argv[++i]
    else if (argv[i] === "--only") options.only = argv[++i]
    else if (argv[i] === "--json") options.json = true
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node scripts/check-import-cycles.mjs [--root src] [--only src/session/] [--json]")
      process.exit(0)
    } else {
      console.error(`unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  return options
}

function toRel(file) {
  // 归一化正斜杠：Windows 上 path.relative 产生反斜杠，报告与断言都按
  // "src/session/loop.mjs" 这种字面量比对（wiring-contract 测试栽过这个坑）
  return path.relative(REPO_ROOT, file).split(path.sep).join("/")
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const rootDir = path.resolve(REPO_ROOT, options.root)
  const { files, edges, unresolved } = await collectImportGraph(rootDir)
  let sccs = findSccs(edges)
  if (options.only) {
    const prefix = path.resolve(REPO_ROOT, options.only)
    sccs = sccs.filter((scc) => scc.some((file) => file === prefix || file.startsWith(prefix + path.sep)))
  }

  if (options.json) {
    console.log(JSON.stringify({
      root: toRel(rootDir) || ".",
      files: files.length,
      unresolved: unresolved.map((u) => ({ from: toRel(u.from), spec: u.spec })),
      cycles: sccs.map((members) => ({
        files: members.map(toRel),
        witness: witnessCycle(members, edges).map(toRel)
      }))
    }, null, 2))
  } else {
    console.log(`scanned ${files.length} files under ${toRel(rootDir) || "."}`)
    if (unresolved.length) {
      console.log(`warning: ${unresolved.length} relative import(s) could not be resolved (graph may be incomplete):`)
      for (const u of unresolved) console.log(`  ${toRel(u.from)} -> "${u.spec}"`)
    }
    if (sccs.length === 0) {
      console.log("no import cycles detected")
    } else {
      for (const members of sccs) {
        console.log(`\nimport cycle detected (${members.length} files):`)
        for (const member of members) console.log(`  ${toRel(member)}`)
        console.log(`  witness: ${witnessCycle(members, edges).map(toRel).join(" -> ")}`)
      }
      console.log(`\n${sccs.length} import cycle(s) detected`)
    }
  }
  process.exit(sccs.length ? 1 : 0)
}
