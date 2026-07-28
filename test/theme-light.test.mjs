import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { LIGHT_THEME } from "../src/theme/light-theme.mjs"
import { validateTheme } from "../src/theme/schema.mjs"
import { relativeLuminance, isLightBackground } from "../src/theme/background-probe.mjs"

/**
 * 浅色主题。
 *
 * 这里最重要的一条是**键集合一致** —— 两份手写调色板靠记忆同步会静默失效：
 * 深色主题加一个 `markdown.syntaxRegexp`，浅色这边漏掉的话，切到 light 之后那个
 * 元素会拿到 undefined 然后不着色，而任何结构测试都不会红。这个仓库栽过同一条
 * （手写清单在枚举增长时静默失效），所以这里比的是递归展开后的**全部路径**，
 * 不是「都有 base/semantic/…」这种粗粒度。
 */

/** 递归展开成 "markdown.heading1" 这样的路径清单。 */
function keyPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix]
  return Object.keys(value)
    .flatMap((key) => keyPaths(value[key], prefix ? `${prefix}.${key}` : key))
    .sort()
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  assert.ok(m, `不是十六进制颜色: ${hex}`)
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

/** WCAG 对比度。1 = 完全一样，21 = 黑白。 */
function contrast(a, b) {
  const la = relativeLuminance(hexToRgb(a))
  const lb = relativeLuminance(hexToRgb(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

test("浅色主题与深色主题的键结构完全一致", () => {
  // 两边都展开成全路径再比。少一个键就红，多一个也红。
  assert.deepEqual(keyPaths(LIGHT_THEME), keyPaths(DEFAULT_THEME))
})

test("浅色主题过得了主题校验", () => {
  const check = validateTheme(LIGHT_THEME)
  assert.deepEqual(check.errors, [], "不合法的主题会被 loadTheme 静默换成默认主题")
  assert.equal(check.valid, true)
})

test("每个颜色要么是十六进制，要么是显式的 null", () => {
  // null 是「不着色」的合法取值（markdown.text）；undefined 与颜色名不是。
  for (const path of keyPaths(LIGHT_THEME)) {
    const value = path.split(".").reduce((node, key) => node[key], LIGHT_THEME)
    if (value === null) continue
    if (path === "name") { assert.equal(typeof value, "string"); continue }
    assert.match(String(value), /^#[0-9a-f]{6}$/i, `${path} 不是十六进制颜色: ${value}`)
  }
})

test("正文与 muted 在自己的背景上读得清", () => {
  const bg = LIGHT_THEME.base.bg
  assert.ok(isLightBackground(hexToRgb(bg)), "浅色主题的背景得真的是浅色")
  assert.ok(contrast(LIGHT_THEME.base.fg, bg) >= 7,
    `正文对比度只有 ${contrast(LIGHT_THEME.base.fg, bg).toFixed(1)}:1`)
  assert.ok(contrast(LIGHT_THEME.base.muted, bg) >= 4.5,
    `muted 对比度只有 ${contrast(LIGHT_THEME.base.muted, bg).toFixed(1)}:1 —— 次要信息也是要读的`)
  assert.ok(contrast(LIGHT_THEME.roles.assistant, bg) >= 7, "模型回复是正文，不是次要信息")
})

test("diff 的红绿在白底上既够深、彼此又分得开", () => {
  const bg = LIGHT_THEME.base.bg
  const add = LIGHT_THEME.components.diff_add
  const del = LIGHT_THEME.components.diff_del
  assert.ok(contrast(add, bg) >= 3, `+ 行 ${contrast(add, bg).toFixed(1)}:1，白底上太浅`)
  assert.ok(contrast(del, bg) >= 3, `- 行 ${contrast(del, bg).toFixed(1)}:1，白底上太浅`)
  // 红绿色觉障碍下只剩明度差可用 —— 两者明度必须拉开
  assert.ok(contrast(add, del) >= 1.2,
    `红绿之间只有 ${contrast(add, del).toFixed(2)}:1，色觉障碍下会分不出增删`)
})

test("语义色不是照搬深色主题的亮色档", () => {
  // 深色主题的语义色是给黑底调的（#f87171 这类 400 档），放到白底上对比度只有
  // 2:1 出头。这条把「顺手复制一份」挡住。
  for (const key of Object.keys(DEFAULT_THEME.semantic)) {
    assert.notEqual(LIGHT_THEME.semantic[key], DEFAULT_THEME.semantic[key], `semantic.${key} 与深色主题相同`)
    const ratio = contrast(LIGHT_THEME.semantic[key], LIGHT_THEME.base.bg)
    assert.ok(ratio >= 3.5, `semantic.${key} 在浅底上只有 ${ratio.toFixed(1)}:1`)
  }
})

test("选中行在浅底上仍然看得出被选中", () => {
  // 深色主题是「亮蓝底 + 近黑字」，白底照抄的话选中行与普通行明度几乎一样。
  assert.ok(contrast(LIGHT_THEME.overlay.selectedFg, LIGHT_THEME.overlay.selectedBg) >= 4.5,
    "选中行的前景/背景对比度不足")
  assert.ok(contrast(LIGHT_THEME.overlay.selectedBg, LIGHT_THEME.base.bg) >= 3,
    "选中背景与页面背景太接近，看不出选中在哪")
})
