import test, { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { renderSelectOverlay, scrollWindow } from "../src/ui/overlay-select.mjs"
import { paint, setColorEnabled } from "../src/theme/color.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"

/**
 * 0.5.8：四个选单（模型 / 模式 / 权限策略 / 权限请求）合成一个组件。
 * 这批断言守着两件事：框线与行数的稳定（fixedRows 依赖它），以及
 * 无色终端下选中项仍然可辨认。
 */

const theme = DEFAULT_THEME
function padRight(text, width) {
  const raw = String(text ?? "")
  return raw.length >= width ? raw.slice(0, width) : raw + " ".repeat(width - raw.length)
}
const base = { width: 60, theme, accent: theme.semantic.info, paint, padRight }

afterEach(() => setColorEnabled(null))

describe("滚动窗口", () => {
  it("选中项始终落在可见范围内", () => {
    assert.deepEqual(scrollWindow({ total: 12, selected: 0, offset: 0, maxVisible: 5 }), { start: 0, end: 5, visible: 5 })
    // 向下越界 → 窗口跟着走
    assert.equal(scrollWindow({ total: 12, selected: 9, offset: 0, maxVisible: 5 }).start, 5)
    // 向上越界 → 窗口回退
    assert.equal(scrollWindow({ total: 12, selected: 1, offset: 6, maxVisible: 5 }).start, 1)
  })

  it("项数少于窗口时不越界", () => {
    const win = scrollWindow({ total: 3, selected: 2, offset: 0, maxVisible: 10 })
    assert.deepEqual(win, { start: 0, end: 3, visible: 3 })
  })
})

describe("渲染", () => {
  const items = [
    { label: "alpha", desc: "first" },
    { label: "beta", desc: "second", current: true },
    { label: "gamma", desc: "third" }
  ]

  it("行数 = 标题 + 上下边框 + 项数（无溢出时）", () => {
    const { lines } = renderSelectOverlay({ ...base, title: "Pick", items, selected: 0 })
    assert.equal(lines.length, 1 + 1 + items.length + 1)
  })

  it("溢出时多一行计数提示，且行数仍然可预测", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `item-${i}` }))
    const { lines } = renderSelectOverlay({ ...base, title: "Pick", items: many, selected: 0, maxVisible: 5 })
    assert.equal(lines.length, 1 + 1 + 5 + 1 + 1)
    assert.match(lines.at(-1), /1-5 of 12/)
  })

  it("header 行会带一条分隔线，计入行数", () => {
    const { lines } = renderSelectOverlay({
      ...base, title: "Permission", items, selected: 0,
      header: [{ text: "tool: bash" }, { text: "target: rm -rf" }]
    })
    assert.equal(lines.length, 1 + 1 + 2 + 1 + items.length + 1)
  })

  it("返回修正后的 offset，供调用方回写", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `item-${i}` }))
    const { offset } = renderSelectOverlay({ ...base, title: "T", items: many, selected: 9, offset: 0, maxVisible: 5 })
    assert.equal(offset, 5)
  })

  it("每行宽度一致 —— 框线不会参差", () => {
    setColorEnabled(false)
    const { lines } = renderSelectOverlay({ ...base, title: "Pick", items, selected: 1 })
    const widths = new Set(lines.slice(1, -1).map((l) => l.length))
    assert.equal(widths.size, 1, `边框宽度不一致: ${[...widths].join(",")}`)
  })
})

describe("无色终端下仍然可用", () => {
  const items = [{ label: "alpha" }, { label: "beta" }]

  it("选中行靠 ▸ 前缀标识，而不是只靠反白背景", () => {
    setColorEnabled(false)
    const { lines } = renderSelectOverlay({ ...base, title: "T", items, selected: 1 })
    // 无色时没有任何 SGR 序列
    assert.doesNotMatch(lines.join("\n"), /\[/)
    const rows = lines.slice(2, -1)
    assert.match(rows[1], /▸/, "选中行必须有前缀")
    assert.doesNotMatch(rows[0], /▸/, "未选中行不该有前缀")
  })

  it("打开配色后选中行确实带反白背景", () => {
    setColorEnabled(true)
    const { lines } = renderSelectOverlay({ ...base, title: "T", items, selected: 1 })
    const rows = lines.slice(2, -1)
    assert.match(rows[1], /\[48;2;/, "选中行应有背景色")
  })

  it("current 标记与选中前缀是两件事，可同时出现", () => {
    setColorEnabled(false)
    const { lines } = renderSelectOverlay({
      ...base, title: "T", markers: true, selected: 0,
      items: [{ label: "a", current: true }, { label: "b" }]
    })
    const rows = lines.slice(2, -1)
    assert.match(rows[0], /▸ ●/)
  })
})
