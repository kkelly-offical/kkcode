import test from "node:test"
import assert from "node:assert/strict"
import { renderSuggestions } from "../src/repl/suggestion-view.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"
import { stripAnsi } from "../src/repl/frame-primitives.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"

/**
 * 候选表的渲染。
 *
 * 两条是可用性硬约束，不是审美偏好：
 *
 *   1. **选中项在无色终端下也要看得出来。** 测试进程不是 TTY，`paint()` 恒返回原文，
 *      所以「只靠颜色区分」的实现在这里天然就是不可见的 —— 断言 `▸` 前缀等于断言
 *      NO_COLOR 下的可用性。
 *   2. **索引封顶要说出来。** 悄悄封顶会让人以为「补全里没有就是仓库里没有」。
 */

const THEME = DEFAULT_THEME

// 显式关掉上色：默认跟随 TTY，而配色开着时 stripAnsi 之外的断言会读到色码。
test.before(() => setColorEnabled(false))
test.after(() => setColorEnabled(null))

const mention = (items, extra = {}) => ({
  kind: "mention",
  sigil: "@",
  query: "rep",
  items,
  total: items.length,
  truncated: false,
  maxFiles: 20000,
  ...extra
})

/** 行尾的补白是 clipAnsiLine 的活（每行必须恰好占满宽度），断言只关心内容。 */
const render = (suggestions, patch = {}) => renderSuggestions({
  suggestions,
  selected: 0,
  offset: 0,
  maxVisible: 5,
  theme: THEME,
  width: 100,
  ...patch
}).lines.map((line) => stripAnsi(line).trimEnd())

test("文件候选的标题说清楚是文件、选中第几条、按什么键", () => {
  const lines = render(mention([
    { name: "src/repl.mjs", desc: "", matched: [[4, 8]] },
    { name: "src/repl/file-index.mjs", desc: "", matched: [[4, 8]] }
  ]), { selected: 1 })
  assert.equal(lines[0], "Files (2/2)  Enter choose")
})

test("索引被截断时标题必须说出来", () => {
  const capped = render(mention(
    [{ name: "a.mjs", desc: "", matched: [] }],
    { truncated: true, maxFiles: 500 }
  ))
  assert.match(capped[0], /index capped at 500 files/)

  const full = render(mention([{ name: "a.mjs", desc: "", matched: [] }]))
  assert.doesNotMatch(full[0], /capped/, "没截断时不该无中生有")
})

test("选中项在无色终端下靠 ▸ 前缀区分，不是只靠背景色", () => {
  const lines = render(mention([
    { name: "src/repl.mjs", desc: "", matched: [] },
    { name: "README.md", desc: "", matched: [] }
  ]), { selected: 1 })
  // paint 在非 TTY 下返回原文，所以这里读到的就是 NO_COLOR 终端看到的东西
  assert.ok(lines[1].startsWith("  @src/repl.mjs"), `未选中行不该有标记：${JSON.stringify(lines[1])}`)
  assert.ok(lines[2].startsWith("▸ @README.md"), `选中行必须带 ▸：${JSON.stringify(lines[2])}`)
})

test("命中的字符用方括号标出来，位置对着原始路径", () => {
  // 区间来自 file-rank，索引对着原始 path。标错位比不标更糟 —— 用户会以为匹配到了别处。
  const lines = render(mention([{ name: "src/repl.mjs", desc: "", matched: [[4, 8]] }]))
  assert.ok(lines[1].includes("@src/[repl].mjs"), lines[1])
})

test("没有命中区间时路径原样显示", () => {
  const lines = render(mention([{ name: "src/repl.mjs", desc: "", matched: [] }]))
  assert.ok(lines[1].includes("@src/repl.mjs"))
  assert.ok(!lines[1].includes("["), "空区间不该长出括号")
})

test("单字符命中不标，双字符起才标 —— 阈值两侧各一条", () => {
  // 一对方括号是两个字符的噪声。标一个字符时它换来的信号还不如噪声多。
  // 区间是半开的（end 独占），所以 [4,5] 是一个字符、[4,6] 是两个。
  const single = render(mention([{ name: "src/repl.mjs", desc: "", matched: [[4, 5]] }]))
  assert.ok(single[1].includes("@src/repl.mjs"), single[1])
  assert.ok(!single[1].includes("["), `单字符命中不该标：${single[1]}`)

  const double = render(mention([{ name: "src/repl.mjs", desc: "", matched: [[4, 6]] }]))
  assert.ok(double[1].includes("@src/[re]pl.mjs"), double[1])
})

test("散射式子序列命中：整条路径原样输出，不被拆碎", () => {
  // `@src/[a]gen[t]/promp[t]/[a]r[ch]itect.txt` 这种已经读不出原本的路径了，
  // 而这类候选本来就排在后面 —— 用户需要的是一眼扫过去跳过它。
  const lines = render(mention([{
    name: "src/agent/prompt/architect.txt",
    desc: "",
    // s0 r1 c2 /3 a4 g5 e6 n7 t8 /9 p10 r11 o12 m13 p14 t15 /16 a17 r18 c19 h20 …
    matched: [[4, 5], [8, 9], [15, 16], [17, 18], [19, 21]]
  }]))
  assert.ok(lines[1].includes("@src/agent/prompt/ar[ch]itect.txt"), lines[1])
  assert.equal((lines[1].match(/\[/g) || []).length, 1, "只该留下那一段长命中")
})

test("全是单字符命中时一个方括号都不留", () => {
  const lines = render(mention([{
    name: "src/agent/prompt.txt",
    desc: "",
    matched: [[0, 1], [4, 5], [10, 11]]
  }]))
  assert.ok(lines[1].includes("@src/agent/prompt.txt"), lines[1])
  assert.ok(!lines[1].includes("["), `碎片全丢掉后应当原样输出：${lines[1]}`)
})

test("命令候选仍按原样式：前导符 + 对齐的命令名 + 说明", () => {
  const lines = render({
    kind: "slash",
    sigil: "/",
    query: "he",
    items: [{ name: "help", desc: "show help" }],
    total: 1,
    truncated: false,
    maxFiles: 0
  })
  assert.equal(lines[0], "Slash Commands (1/1)  Enter choose, Enter again execute")
  assert.match(lines[1], /^▸ \/help {11}show help/)
})

test("技能候选的标题与命令候选分得开", () => {
  const lines = render({
    kind: "skill",
    sigil: "$",
    query: "",
    items: [{ name: "review", desc: "skill (project)" }],
    total: 1,
    truncated: false,
    maxFiles: 0
  })
  assert.match(lines[0], /^Skills \(1\/1\)/)
})

test("没有候选就一行都不画", () => {
  assert.deepEqual(render(mention([])), [])
  assert.deepEqual(render({ kind: null, sigil: null, items: [], truncated: false, maxFiles: 0 }), [])
})

test("候选比可见窗口多时给出滚动提示，且选中项始终在窗口内", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.mjs`, desc: "", matched: [] }))
  const rendered = renderSuggestions({
    suggestions: mention(items),
    selected: 9,
    offset: 0,
    maxVisible: 5,
    theme: THEME,
    width: 100
  })
  const lines = rendered.lines.map((line) => stripAnsi(line).trimEnd())
  assert.equal(rendered.offset, 5, "窗口要跟着选中项滚")
  assert.ok(lines.some((line) => line.startsWith("▸ @f9.mjs")), lines.join("\n"))
  assert.equal(lines.at(-1), "scroll: 6-10/12 (Up/Down)")
})
