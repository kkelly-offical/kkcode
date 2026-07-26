import test from "node:test"
import assert from "node:assert/strict"
import {
  matchFilter,
  filterOverlayItems,
  markMatchRanges,
  createPickerFilterState,
  applyOverlayFilter,
  resolvePickerChoice,
  renderSelectOverlay,
  MATCH_TIER
} from "../src/ui/overlay-select.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { paint } from "../src/theme/color.mjs"
import { padRight, displayWidth, stripAnsi } from "../src/repl/frame-primitives.mjs"

/**
 * 选择器的打字过滤引擎。
 *
 * `/resume` 列 30 个会话时只能一路按下箭头 —— 过滤是唯一的解法，但它有两处
 * 特别容易写错，两处都在这里被单独钉死：
 *
 *   1. **排序档位**：不分档的话「碰巧按顺序含有 g、p、t」的项会和 `gpt-5` 混排；
 *   2. **选中跟随**：过滤后下标全变了，把 selected 留在原位等于选中了另一个东西。
 */

/**
 * 顺序是刻意排的：过滤 "auth" 之后档位排序会把它们**完全打乱**
 * （s4 前缀 → s3 子串 → s1 子序列，s2 被滤掉）。
 *
 * 如果候选的过滤前后下标恰好一样，「选中跟随」的用例就会在实现坏掉时仍然绿 ——
 * 第一版就是这样，靠红绿验证才发现。
 */
const ITEMS = [
  { id: "s1", label: "align user token help" },  // 子序列 a…u…t…h
  { id: "s2", label: "rewrite the parser" },     // 不匹配
  { id: "s3", label: "refactor auth module" },   // 子串
  { id: "s4", label: "authorize the deploy" }    // 前缀
]

// --- 单项匹配 ---

test("a match is graded prefix, substring or subsequence", () => {
  assert.deepEqual(matchFilter("authorize", "auth"),
    { tier: MATCH_TIER.prefix, start: 0, ranges: [[0, 4]] })
  assert.deepEqual(matchFilter("refactor auth", "auth"),
    { tier: MATCH_TIER.substring, start: 9, ranges: [[9, 13]] })
  assert.equal(matchFilter("align user token help", "auth").tier, MATCH_TIER.subsequence)
  assert.equal(matchFilter("rewrite the parser", "auth"), null, "缺一个字符就不该算命中")
})

test("matching ignores case in both directions", () => {
  assert.equal(matchFilter("Authorize", "auth").tier, MATCH_TIER.prefix)
  assert.equal(matchFilter("authorize", "AUTH").tier, MATCH_TIER.prefix)
})

test("a missing label does not become the literal string \"undefined\"", () => {
  // String(undefined) === "undefined"，于是输 "n"、"def"、"ine" 都能命中一个
  // 压根没有 label 的候选。policyPicker 的选项数组就可能是这种形状。
  assert.equal(matchFilter(undefined, "n"), null)
  assert.equal(matchFilter(null, "def"), null)
  assert.deepEqual(filterOverlayItems([{ value: "x" }, { label: "define" }], "def")
    .map((hit) => hit.sourceIndex), [1])
})

test("an empty query matches everything with no ranges", () => {
  assert.deepEqual(matchFilter("anything", ""), { tier: -1, start: 0, ranges: [] })
  assert.equal(filterOverlayItems(ITEMS, "").length, ITEMS.length)
})

// --- 排序 ---

test("prefix beats substring beats subsequence", () => {
  const order = filterOverlayItems(ITEMS, "auth").map((hit) => ITEMS[hit.sourceIndex].id)
  assert.deepEqual(order, ["s4", "s3", "s1"],
    "不分档的话子序列命中会和前缀命中混在一起，等于没排序")
})

test("within one tier the earlier hit wins, and ties keep the original order", () => {
  const items = [
    { label: "xxxxx gpt" },   // 子串，位置 6
    { label: "x gpt" },       // 子串，位置 2
    { label: "gpt-a" },       // 前缀
    { label: "gpt-b" }        // 前缀，与上一条同档同位置
  ]
  assert.deepEqual(
    filterOverlayItems(items, "gpt").map((hit) => hit.sourceIndex),
    [2, 3, 1, 0],
    "同档按命中位置靠前优先；完全平手时保持原顺序（会话是按时间倒序排的）")
})

// --- 区间标注 ---

test("adjacent ranges are merged so a subsequence hit stays readable", () => {
  // 例子必须**不是子串命中** —— 子串档位本来就只有一段区间，走不到合并那段代码。
  // 用 "beautiful" 试的话 "aut" 是子串，这条断言就是对着空气成立的。
  const hit = matchFilter("beau tiful", "aut")
  assert.equal(hit.tier, MATCH_TIER.subsequence, "先确认真的走到了子序列档位")
  assert.deepEqual(hit.ranges, [[2, 4], [5, 6]], "a 与 u 相邻，应并成一段")
  assert.equal(markMatchRanges("beau tiful", hit.ranges), "be[au] [t]iful",
    "不合并的话会标成 be[a][u] [t]iful")
})

test("a scattered subsequence marks each run separately", () => {
  const hit = matchFilter("align user token help", "auth")
  assert.equal(markMatchRanges("align user token help", hit.ranges), "[a]lign [u]ser [t]oken [h]elp")
})

test("marking is plain text, so it survives NO_COLOR and padRight", () => {
  // padRight 会先 stripAnsi 再补位（frame-primitives.mjs:59），行内颜色码会被它
  // 吃掉；而方括号是文本，无色终端下也仍然带着「为什么这项匹配上了」的信息。
  const marked = markMatchRanges("authorize", [[0, 4]])
  assert.equal(marked, "[auth]orize")
  assert.equal(stripAnsi(marked), marked, "标注里不该有颜色码")
})

// --- 状态转移 ---

function picker() {
  return createPickerFilterState(ITEMS, 0)
}

test("an unfiltered picker shows the original array itself", () => {
  const state = picker()
  assert.equal(state.items, ITEMS, "没过滤时不该复制，渲染方拿到的就是原件")
  assert.equal(state.filter, "")
})

test("typing narrows the list and marks why each row matched", () => {
  const state = applyOverlayFilter(picker(), "auth")
  assert.deepEqual(state.items.map((item) => item.id), ["s4", "s3", "s1"])
  assert.equal(state.items[0].label, "[auth]orize the deploy")
  assert.equal(state.filter, "auth")
  assert.equal(ITEMS[3].label, "authorize the deploy", "原件不能被改写")
})

test("the selection follows the item it was on", () => {
  const state = picker()
  state.selected = 0                       // s1 "align user token help"
  applyOverlayFilter(state, "auth")        // 它仍在结果里，但排到了第 3 行
  assert.equal(state.selected, 2)
  assert.equal(resolvePickerChoice(state).id, "s1",
    "过滤后把 selected 留在原位就会选中另一个东西 —— /resume 会续跑错的会话")
})

test("the selection falls back to the top when its item is filtered out", () => {
  const state = picker()
  state.selected = 1                       // s2 "rewrite the parser"
  applyOverlayFilter(state, "auth")        // 它被滤掉了
  assert.equal(state.selected, 0)
  assert.equal(resolvePickerChoice(state).id, "s4")
})

test("clearing the filter puts you back on the row you had highlighted", () => {
  const state = picker()
  applyOverlayFilter(state, "auth")
  state.selected = 1                       // 过滤结果的第 2 行 = s3，原列表第 3 项
  applyOverlayFilter(state, "")
  assert.equal(state.items, ITEMS, "清掉过滤后又是原件")
  assert.equal(state.selected, 2)
  assert.equal(resolvePickerChoice(state).id, "s3")
})

test("a stale offset cannot survive a filter change", () => {
  const state = picker()
  state.offset = 3
  applyOverlayFilter(state, "auth")
  assert.equal(state.offset, 0, "留着旧 offset 会在变短的列表上显示成一片空白")
})

test("confirming returns the original item, not the bracket-marked copy", () => {
  const state = applyOverlayFilter(picker(), "auth")
  state.selected = 0
  assert.equal(state.items[0].label, "[auth]orize the deploy", "先确认它确实被标注了")
  assert.equal(resolvePickerChoice(state), ITEMS[3], "确认动作要的是原件")
})

test("filtering everything away leaves nothing selectable", () => {
  const state = applyOverlayFilter(picker(), "zzz")
  assert.deepEqual(state.items, [])
  assert.equal(resolvePickerChoice(state), null, "Enter 此时不该取出任何东西")
})

test("a hand-built picker state without all/matches still filters", () => {
  // 老形状（只有 items/selected/offset）在别处仍会被手工构造出来
  const state = { items: ITEMS, selected: 0, offset: 0 }
  applyOverlayFilter(state, "auth")
  assert.deepEqual(state.items.map((item) => item.id), ["s4", "s3", "s1"])
  assert.equal(state.selected, 2, "旧形状下的 selected 也要跟着走")
})

// --- 渲染 ---

function render(items, width = 60) {
  return renderSelectOverlay({
    title: "Resume Session",
    items,
    selected: 0,
    width,
    theme: DEFAULT_THEME,
    accent: DEFAULT_THEME.semantic.info,
    paint,
    padRight
  })
}

test("an empty result says so instead of drawing an empty box", () => {
  const text = render([]).lines.map(stripAnsi).join("\n")
  assert.match(text, /no match/, "空框看起来和卡住一模一样")
  assert.match(text, /Backspace/, "还要说清楚怎么退出这个状态")
})

test("the no-match row keeps the box rectangular", () => {
  for (const width of [40, 60, 100]) {
    // 标题行不属于方框，其余每一行都必须和边框一样宽，否则框会参差
    const box = render([], width).lines.map(stripAnsi).filter((line) => /^[┌│└]/.test(line))
    assert.equal(box.length, 3, `宽 ${width}：应当是「上边框 + 提示行 + 下边框」`)
    const widths = new Set(box.map((line) => displayWidth(line)))
    assert.deepEqual([...widths], [width - 2], `宽 ${width} 下方框各行宽度: ${[...widths]}`)
  }
})

test("a non-empty list is untouched by the no-match row", () => {
  const text = render([{ label: "甲" }, { label: "乙" }]).lines.map(stripAnsi).join("\n")
  assert.doesNotMatch(text, /no match/)
  assert.match(text, /▸ 甲/, "选中行的 ▸ 前缀是无色终端下唯一的选中线索")
})
