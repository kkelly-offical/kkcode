import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { measureFunctions, countLines, stripCommentsAndStrings } from "../src/util/source-metrics.mjs"

/**
 * 结构守卫：让 0.6.15–0.6.26 这十几个版本的拆分不会在半年内长回去。
 *
 * `repl.mjs` 从 4563 行拆到 1968 行、43 个模块。没有守卫的话，下一次「就先加在
 * repl.mjs 里吧」会开始把它涨回去 —— 那正是它当初变成 4563 行的过程。
 *
 * 这里的每条规则都对应一个具体踩过的坑，不是抽象的整洁度偏好。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const REPL_DIR = path.join(ROOT, "src", "repl")

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : [path.join(dir, entry.name)])
    .filter((file) => file.endsWith(".mjs"))
}

const MODULES = walk(REPL_DIR)
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/")

/**
 * 度量用 src/util/source-metrics.mjs，不在这里自己切行。
 *
 * 原因是 0.6.27 在 Windows 上红了：仓库没有 .gitattributes，git 可能按 CRLF 签出，
 * 而按 `\n` 切行后每行尾部带着 `\r`，函数边界一个都找不到、判定点爆表。
 * 那个模块把行尾归一，并且有**在 Linux 上也会红**的测试守着（test/source-metrics）。
 */
function functionsIn(file) {
  return measureFunctions(fs.readFileSync(file, "utf8"))
    .map((fn) => ({ ...fn, file }))
}

const linesOf = (file) => countLines(fs.readFileSync(file, "utf8"))

// --- 依赖方向 ---

test("no module under src/repl imports repl.mjs", () => {
  // repl.mjs 是组装根：它 import 别人，别人不 import 它。反过来就是循环依赖，
  // 而且意味着那个模块其实拿不到自己需要的东西、只好回头去掏根。
  const offenders = []
  for (const file of MODULES) {
    const src = fs.readFileSync(file, "utf8")
    if (/from\s+"[^"]*\/repl\.mjs"/.test(src) || /from\s+"\.\.\/repl\.mjs"/.test(src)) {
      offenders.push(rel(file))
    }
  }
  assert.deepEqual(offenders, [], `这些模块反过来依赖了组装根:\n  ${offenders.join("\n  ")}`)
})

test("modules do not reach outside src/", () => {
  const offenders = []
  for (const file of MODULES) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]*)"/g)) {
      const target = path.resolve(path.dirname(file), m[1])
      if (!target.startsWith(path.join(ROOT, "src"))) offenders.push(`${rel(file)} -> ${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `越出 src/ 的相对导入:\n  ${offenders.join("\n  ")}`)
})

// --- 复杂度：按判定点，不按行数 ---

/**
 * 已知超标、暂未处理的函数。**这是一个只减不增的清单** —— 新写的东西超标就红。
 *
 * 为什么按判定点而不是行数：`createEditorKeyScope` 有 276 行但只有 26 个判定点
 * （它是一张声明式的按键表），而 `submitCurrentInput` 368 行有 86 个判定点。
 * 前者读起来是一张表，后者是一台状态机。按行数一刀切会误伤前者、放过后者。
 */
const KNOWN_COMPLEX = new Map([
  ["src/repl.mjs:startTuiRepl", 189],       // 组装根，随拆分逐步下降（起点 2816 行）
  ["src/repl.mjs:submitCurrentInput", 86],  // 回合状态机，计划里放最后
  ["src/repl/frame-builder.mjs:buildFrame", 72]  // 整帧组装，分支多但线性
])
const DECISION_CAP = 60

test("no new function exceeds the complexity cap", () => {
  const all = [...MODULES, path.join(ROOT, "src", "repl.mjs")].flatMap(functionsIn)
  const offenders = all
    .filter((fn) => fn.decisions > DECISION_CAP)
    .map((fn) => ({ key: `${rel(fn.file)}:${fn.name}`, decisions: fn.decisions }))
    .filter((fn) => !KNOWN_COMPLEX.has(fn.key))
  assert.deepEqual(offenders, [],
    `这些函数的判定点超过 ${DECISION_CAP}：\n  ` +
    offenders.map((o) => `${o.key} (${o.decisions})`).join("\n  ") +
    "\n拆开它，或者在 KNOWN_COMPLEX 里显式记一笔并说明为什么。")
})

test("the known-complex list only ever shrinks", () => {
  // 棘轮：清单里的函数只能变简单，不能变复杂。变复杂了说明有人在往里加东西。
  const all = [...MODULES, path.join(ROOT, "src", "repl.mjs")].flatMap(functionsIn)
  const byKey = new Map(all.map((fn) => [`${rel(fn.file)}:${fn.name}`, fn.decisions]))
  const grown = []
  const gone = []
  for (const [key, budget] of KNOWN_COMPLEX) {
    const actual = byKey.get(key)
    if (actual === undefined) { gone.push(key); continue }
    if (actual > budget) grown.push(`${key}: ${budget} -> ${actual}`)
  }
  assert.deepEqual(grown, [], `已知超标函数又变复杂了:\n  ${grown.join("\n  ")}`)
  assert.deepEqual(gone, [],
    `这些函数已经不存在了，请从 KNOWN_COMPLEX 移除（清单留着陈旧条目会掩盖新问题）:\n  ${gone.join("\n  ")}`)
})

// --- 工厂的依赖必须写在签名里 ---

test("a factory that takes a bag of collaborators must name them", () => {
  // 这不是风格偏好。frame-builder 的抽取之所以当场逼出四个真实缺陷，正是因为它
  // 被迫写出了显式参数表 —— 漏掉哪个自由变量会立刻 ReferenceError。接收一个万能
  // session 对象的话，耦合重新变成隐式的，只是换了个壳。
  //
  // 但「接一个领域值」不算 —— `createModePickerState(modeId)` 收的是一个模式 id，
  // 不是一袋协作者。判据是**位置参数上被访问了几个不同的键**：多于三个就是袋子。
  const BAG_THRESHOLD = 3
  const offenders = []
  for (const file of MODULES) {
    const src = fs.readFileSync(file, "utf8")
    for (const m of src.matchAll(/export function (create[A-Z]\w*)\s*\(([^)]*)\)\s*\{/g)) {
      const [, name, params] = m
      const first = params.trim()
      if (!first || first.startsWith("{")) continue   // 无参或解构：依赖写在签名里
      const param = first.split(",")[0].split("=")[0].trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(param)) continue
      const body = stripCommentsAndStrings(src.slice(m.index))
      const keys = new Set(
        [...body.matchAll(new RegExp(`(?<![\\w$])${param}\\.([A-Za-z_$][\\w$]*)`, "g"))]
          .map((hit) => hit[1])
      )
      if (keys.size > BAG_THRESHOLD) {
        offenders.push(`${rel(file)}:${name}(${param}) 用到了 ${keys.size} 个字段: ${[...keys].join(", ")}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    "这些工厂收了一袋协作者却没有点名，依赖看不出来:\n  " + offenders.join("\n  "))
})

// --- 组装根的规模棘轮 ---

const REPL_LINE_BUDGET = 2050

test("repl.mjs does not grow back", () => {
  // 起点 4563 行。没有这条的话，下一次「就先加在 repl.mjs 里吧」会开始把它涨回去 ——
  // 那正是它当初变成 4563 行的过程。拆下去时把预算一起调小。
  const lines = linesOf(path.join(ROOT, "src", "repl.mjs"))
  assert.ok(lines <= REPL_LINE_BUDGET,
    `repl.mjs 有 ${lines} 行，超过预算 ${REPL_LINE_BUDGET}。` +
    "新代码应当进 src/repl/ 下的模块；确实该留在组装根的话，把预算调大并说明理由。")
})

test("the line budget is not left far above reality", () => {
  // 预算比现实高太多就等于没有 —— 会悄悄给回涨留出空间
  const lines = linesOf(path.join(ROOT, "src", "repl.mjs"))
  assert.ok(REPL_LINE_BUDGET - lines <= 300,
    `预算 ${REPL_LINE_BUDGET} 比实际 ${lines} 行高出太多，请调紧`)
})

// --- 模块自身的规模 ---

test("every module stays small enough to hold in your head", () => {
  const BUDGET = 700
  const big = MODULES
    .map((file) => ({ file: rel(file), lines: linesOf(file) }))
    .filter((m) => m.lines > BUDGET)
  assert.deepEqual(big, [],
    `这些模块超过 ${BUDGET} 行:\n  ` + big.map((m) => `${m.file} (${m.lines})`).join("\n  "))
})

test("the split actually produced modules, not one big file plus scraps", () => {
  // 防呆：如果哪天有人把模块合并回去，上面那些规则会一条条通过而结构已经没了
  assert.ok(MODULES.length >= 35, `src/repl 下只有 ${MODULES.length} 个模块，拆分结构可能被合并了`)
  const withTests = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.startsWith("repl-")).length
  assert.ok(withTests >= 20, `repl-* 测试只有 ${withTests} 个，覆盖可能被删了`)
})
