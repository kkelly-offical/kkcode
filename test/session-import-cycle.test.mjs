import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { collectImportGraph, findSccs } from "../scripts/check-import-cycles.mjs"

/**
 * session/ 静态 import 环防回归（1.0.0 阶段 1b）。
 *
 * M3 §四.1 实证的 8 文件 SCC —— engine ↔ loop ↔ system-prompt ↔ engine 加上
 * longagent 家族 → loop 的回向边 —— 此前靠 Node「调用时才解析绑定」硬扛。
 * 破环方式是依赖方向反转：system-prompt 需要的纯契约内容下沉到无依赖叶子
 * mode-contract.mjs，engine 改为再导出。这个测试用 scripts/check-import-cycles.mjs
 * 的同一套图算法断言环不会回来。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "src")
const SESSION = path.join(SRC, "session")

// 归一化正斜杠：Windows 上 path.relative 产生反斜杠，断言比对一律用字面量
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/")

const { files, edges, unresolved } = await collectImportGraph(SRC)
const sccs = findSccs(edges)

test("src/session/ 不参与任何静态 import 环（M3 §四.1 八文件 SCC 防回归）", () => {
  const touching = sccs.filter((scc) => scc.some((f) => f.startsWith(SESSION + path.sep)))
  assert.deepEqual(
    touching.map((scc) => scc.map(rel)),
    [],
    `session/ 又出现了 import 环：\n${touching.map((scc) => scc.map(rel).join(" -> ")).join("\n")}`
  )
})

test("扫描器真的看见了 session/ 的图 —— 防止扫描器静默失效造成假绿", () => {
  // wiring-contract 测试的教训：结构检查最大的风险是扫描器自己坏了、什么都
  // 没扫到而恒绿。这里钉死关键边与关键非边，漏一条就说明图不可信。
  assert.ok(files.length > 250, `只扫到 ${files.length} 个源文件，扫描器可能坏了`)
  assert.deepEqual(unresolved.map((u) => `${rel(u.from)} -> "${u.spec}"`), [], "存在解析失败的相对 import，图不完整")

  const edgeSet = (name) => new Set([...(edges.get(path.join(SESSION, name)) || [])].map(rel))
  for (const anchor of [
    "engine.mjs", "loop.mjs", "system-prompt.mjs", "mode-contract.mjs",
    "longagent.mjs", "longagent-hybrid.mjs", "longagent-plan.mjs",
    "longagent-scaffold.mjs", "longagent-hybrid-helpers.mjs"
  ]) {
    assert.ok(files.some((f) => rel(f) === `src/session/${anchor}`), `锚点 src/session/${anchor} 没被扫到`)
  }

  // 现状的前向边必须在（少了说明解析漏边）
  assert.ok(edgeSet("engine.mjs").has("src/session/loop.mjs"), "engine -> loop 边丢失")
  assert.ok(edgeSet("engine.mjs").has("src/session/longagent.mjs"), "engine -> longagent 边丢失")
  assert.ok(edgeSet("loop.mjs").has("src/session/system-prompt.mjs"), "loop -> system-prompt 边丢失")
  assert.ok(edgeSet("longagent-hybrid.mjs").has("src/session/loop.mjs"), "longagent-hybrid -> loop 边丢失")
  assert.ok(edgeSet("system-prompt.mjs").has("src/session/mode-contract.mjs"), "system-prompt -> mode-contract 边丢失")

  // 被破的闭环比绝不允许回来
  assert.ok(!edgeSet("system-prompt.mjs").has("src/session/engine.mjs"), "system-prompt -> engine 回向边复活")

  // 共享契约必须真的是无依赖叶子
  assert.deepEqual([...edgeSet("mode-contract.mjs")], [], "mode-contract.mjs 不再是叶子模块")
})
