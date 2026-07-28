import test from "node:test"
import assert from "node:assert/strict"
import {
  renderQuestionOverlay,
  visibleQuestionOptions,
  MAX_QUESTION_OPTIONS_VISIBLE
} from "../src/ui/overlay-question.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { paint } from "../src/theme/color.mjs"
import { padRight, stripAnsi } from "../src/repl/frame-primitives.mjs"
import { layoutInputText } from "../src/repl/text-layout.mjs"

/**
 * 提问浮层的滚动窗口与打字过滤（0.8.0）。
 *
 * 此前选项是无窗口全量遍历：/provider add 的模型多选轮发现 60 个模型时整帧
 * 超出终端高度，对话区被压到 2 行 —— 这组测试钉住「行数有上界」这一点。
 */

const MODELS = Array.from({ length: 30 }, (_, i) => ({ label: `model-${String(i).padStart(2, "0")}` }))

function render(overrides = {}) {
  return renderQuestionOverlay({
    pendingQuestion: {
      questions: [{
        id: "m",
        text: "选择模型",
        options: MODELS,
        multi: false,
        allowCustom: true,
        ...(overrides.question || {})
      }]
    },
    questionIndex: 0,
    width: 80,
    theme: DEFAULT_THEME,
    paint,
    padRight,
    layoutInputText,
    ...overrides
  })
}

const plain = (rendered) => rendered.lines.map((line) => stripAnsi(line))
const optionRows = (rendered) => plain(rendered).filter((line) => /[▸ ] [●○☑☐]/.test(line) || line.includes("Custom..."))

test("30 options render as a window, not a wall — row count has a hard ceiling", () => {
  const rendered = render()
  const rows = optionRows(rendered)
  assert.equal(rows.length, MAX_QUESTION_OPTIONS_VISIBLE,
    `选项行必须收在窗口内，实际画了 ${rows.length} 行`)
  const footer = plain(rendered).find((line) => line.includes("of 31"))
  assert.ok(footer, "窗口化时必须有 x-y of N 行 —— 用户要知道列表比看到的长")
  assert.ok(footer.includes("1-8"), `窗口从头开始：${footer}`)
})

test("the window follows the selected option beyond the fold", () => {
  const rendered = render({ questionOptionSelected: 20, questionOptionOffset: 0 })
  const rows = plain(rendered)
  assert.ok(rows.some((line) => line.includes("model-20") && line.includes("▸")),
    "选中项必须可见")
  assert.ok(!rows.some((line) => line.includes("model-00")), "窗口已经滚过了头部")
  assert.equal(rendered.optionOffset, 20 - MAX_QUESTION_OPTIONS_VISIBLE + 1,
    "窗口起点回写给调用方，下一帧从这里继续 —— 否则每帧都会跳回顶部")
})

test("descriptions are suppressed when windowed but kept on short lists", () => {
  const withDesc = MODELS.map((m) => ({ ...m, description: `desc of ${m.label}` }))
  const long = render({ question: { options: withDesc } })
  assert.ok(!plain(long).some((line) => line.includes("desc of")),
    "窗口按选项数算，描述行会把 8 项画成 16 行 —— 窗口化时必须压掉")

  const short = render({ question: { options: withDesc.slice(0, 3) } })
  assert.ok(plain(short).some((line) => line.includes("desc of model-00")),
    "列表短时描述照画，信息不丢")
})

test("a filter narrows the list and marks the match in brackets", () => {
  const rendered = render({ questionFilter: "model-2" })
  const rows = optionRows(rendered)
  // model-2 前缀命中 model-2X 共 10 个，窗口 8 行 + Custom 在窗口外
  assert.equal(rows.length, MAX_QUESTION_OPTIONS_VISIBLE)
  assert.ok(plain(rendered).some((line) => line.includes("[model-2]0")),
    "命中区间用方括号标注（与选择器同一约定，NO_COLOR 下也可见）")
  assert.ok(plain(rendered).some((line) => line.includes("filter: model-2")),
    "过滤串必须能被看见 —— 否则「列表为什么变短了」无从解释")
})

test("filtered to nothing shows the no-match hint instead of an empty frame", () => {
  const rendered = render({ questionFilter: "zzz" })
  assert.ok(plain(rendered).some((line) => line.includes("no match")),
    "空框看起来和「卡住了」一模一样")
  assert.ok(plain(rendered).some((line) => line.includes("Custom...")),
    "Custom 伪项不参与过滤，零命中时它是唯一出路")
})

test("multi-select checkmarks read the source index, not the display position", () => {
  const rendered = render({
    question: { multi: true },
    questionFilter: "model-25",
    questionMultiSelected: { m: new Set([25]) }
  })
  const row = plain(rendered).find((line) => line.includes("model-25"))
  assert.ok(row.includes("☑"), `勾选钉在原选项上：${row}`)
})

test("visibleQuestionOptions is the single derivation shared by render, keys and commit", () => {
  const visible = visibleQuestionOptions({ options: MODELS }, "model-29")
  assert.equal(visible.length, 1)
  assert.equal(visible[0].sourceIndex, 29)
  assert.equal(visible[0].option.label, "model-29")
  // 无过滤时恒等映射
  const all = visibleQuestionOptions({ options: MODELS }, "")
  assert.equal(all.length, 30)
  assert.equal(all[7].sourceIndex, 7)
})
