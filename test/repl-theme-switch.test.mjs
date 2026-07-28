import test from "node:test"
import assert from "node:assert/strict"
import { createThemeSwitcher } from "../src/repl/theme-switch.mjs"
import { DEFAULT_THEME } from "../src/theme/default-theme.mjs"
import { LIGHT_THEME } from "../src/theme/light-theme.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { renderMarkdown, setMarkdownColors } from "../src/theme/markdown.mjs"
import { setColorEnabled } from "../src/theme/color.mjs"

/**
 * 运行时换肤。
 *
 * 最要紧的一条是**对象身份不变**：`ctx.themeState.theme` 在启动时就被
 * `createActivityRenderer` 之类收下存住了，换成新对象只有每帧重读的
 * frame-builder 会跟着变，那几处仍旧画旧配色 —— 半屏新色半屏旧色。
 */

function makeState({ theme = DEFAULT_THEME, source = "default", detectedBackground = null } = {}) {
  return { theme: structuredClone(theme), source, errors: [], detectedBackground }
}

function makeConfig(patch = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.ui = { ...config.ui, ...patch }
  return config
}

test("换肤是就地改内容，themeState.theme 的对象身份不变", () => {
  const themeState = makeState()
  const held = themeState.theme          // 模拟启动时被收下的那份引用
  const switcher = createThemeSwitcher({ themeState, config: makeConfig() })

  switcher.apply("light")
  assert.equal(themeState.theme, held, "换了对象的话，持有旧引用的渲染器会一直画旧配色")
  assert.equal(held.base.fg, LIGHT_THEME.base.fg, "旧引用上必须看得到新颜色")
  assert.equal(held.name, LIGHT_THEME.name)

  switcher.apply("dark")
  assert.equal(themeState.theme, held)
  assert.equal(held.base.fg, DEFAULT_THEME.base.fg, "切回去也要生效")
})

test("旧主题多出来的键要被删掉，不能残留", () => {
  // 文件主题可能带自定义分组。换到内置主题后那些键若留着，
  // 读它们的地方会拿到上一套配色 —— 混色比整套错色更难查。
  const themeState = makeState()
  themeState.theme.custom = { badge: "#ff0000" }
  themeState.theme.base.extraTone = "#00ff00"
  const switcher = createThemeSwitcher({ themeState, config: makeConfig() })

  switcher.apply("light")
  assert.equal("custom" in themeState.theme, false)
  assert.equal("extraTone" in themeState.theme.base, false)
})

test("换肤同时刷新 markdown 的颜色副本", (t) => {
  // markdown.mjs 在 setMarkdownColors 时把颜色**复制**进模块级变量，不持有引用。
  // 漏掉这一刀的表现是：正文与状态栏变了色，标题和代码块还是上一套。
  setColorEnabled(true)
  t.after(() => {
    setColorEnabled(null)
    setMarkdownColors(DEFAULT_THEME.markdown)
  })
  setMarkdownColors(DEFAULT_THEME.markdown)

  const themeState = makeState()
  const switcher = createThemeSwitcher({ themeState, config: makeConfig() })
  const rgb = (hex) => {
    const m = /^#(..)(..)(..)$/.exec(hex)
    return `${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}`
  }

  assert.ok(renderMarkdown("# 标题").includes(rgb(DEFAULT_THEME.markdown.heading1)), "前提：深色主题的标题色")
  switcher.apply("light")
  const rendered = renderMarkdown("# 标题")
  assert.ok(rendered.includes(rgb(LIGHT_THEME.markdown.heading1)),
    "换肤后 markdown 还在用旧的颜色副本")
})

test("列表是 dark / light / auto，当前项被标出来", () => {
  const themeState = makeState()
  const switcher = createThemeSwitcher({ themeState, config: makeConfig() })
  assert.deepEqual(switcher.list().map((item) => item.id), ["dark", "light", "auto"])
  assert.equal(switcher.current(), "dark", "没配过就是内置深色主题")
  assert.deepEqual(switcher.list().filter((item) => item.current).map((item) => item.id), ["dark"])

  switcher.apply("light")
  assert.equal(switcher.current(), "light", "切完之后 current 要跟着走")
  assert.deepEqual(switcher.list().filter((item) => item.current).map((item) => item.id), ["light"])
})

test("配了 theme_file 就多一项，文件名当 id", () => {
  const fileTheme = { ...structuredClone(DEFAULT_THEME), name: "my-file-theme" }
  fileTheme.base.fg = "#abcdef"
  const themeState = makeState({ theme: fileTheme, source: "/home/u/.kkcode/mine.yaml" })
  const switcher = createThemeSwitcher({ themeState, config: makeConfig({ theme_file: "mine.yaml" }) })

  assert.deepEqual(switcher.list().map((item) => item.id), ["dark", "light", "auto", "mine.yaml"])
  assert.equal(switcher.current(), "mine.yaml", "配了文件主题、又没显式指定 theme 时，当前就是文件主题")

  switcher.apply("light")
  assert.equal(themeState.theme.base.fg, LIGHT_THEME.base.fg)
  assert.equal(switcher.apply("mine.yaml").applied, true)
  assert.equal(themeState.theme.base.fg, "#abcdef", "切回文件主题要拿回文件里的颜色")
})

test("theme_file 没加载成功就不列它", () => {
  // loadTheme 对不存在/不合法的主题文件是静默回落默认（source 仍是 "default"）。
  // 把它列出来的话，用户选中之后什么都不会变 —— 比不列更让人困惑。
  const themeState = makeState({ source: "default" })
  const switcher = createThemeSwitcher({ themeState, config: makeConfig({ theme_file: "missing.yaml" }) })
  assert.deepEqual(switcher.list().map((item) => item.id), ["dark", "light", "auto"])
  assert.equal(switcher.current(), "dark")
})

test("行模式每次重造切换器也拿得到文件主题", () => {
  // `/theme` 在没有宿主注入切换器时会临时造一个。快照若只存在闭包里，
  // 第二个切换器就会把「当前是 light」当成文件主题存下来。
  const fileTheme = { ...structuredClone(DEFAULT_THEME), name: "file" }
  fileTheme.base.fg = "#abcdef"
  const themeState = makeState({ theme: fileTheme, source: "/x/mine.yaml" })
  const config = makeConfig({ theme_file: "mine.yaml" })

  createThemeSwitcher({ themeState, config }).apply("light")
  const second = createThemeSwitcher({ themeState, config })
  second.apply("mine.yaml")
  assert.equal(themeState.theme.base.fg, "#abcdef")
})

test("auto 跟随探测结果，探测不到回落深色", () => {
  const dark = makeState({ detectedBackground: null })
  createThemeSwitcher({ themeState: dark, config: makeConfig() }).apply("auto")
  assert.equal(dark.theme.name, DEFAULT_THEME.name, "探测失败必须回落深色，而不是随便挑一个")

  const light = makeState({ detectedBackground: "light" })
  createThemeSwitcher({ themeState: light, config: makeConfig() }).apply("auto")
  assert.equal(light.theme.name, LIGHT_THEME.name)
})

test("auto 每次都重读探测结果，不是构造时定死", () => {
  // 探测是异步的：切换器可能在 OSC 11 应答之前就造好了。
  const themeState = makeState({ detectedBackground: null })
  const switcher = createThemeSwitcher({ themeState, config: makeConfig() })
  switcher.apply("auto")
  assert.equal(themeState.theme.name, DEFAULT_THEME.name)

  themeState.detectedBackground = "light"
  switcher.apply("auto")
  assert.equal(themeState.theme.name, LIGHT_THEME.name)
})

test("认不出来的名字什么都不改", () => {
  const themeState = makeState()
  const saves = []
  const switcher = createThemeSwitcher({
    themeState,
    config: makeConfig(),
    saveUiConfig: (values) => { saves.push(values) }
  })
  const result = switcher.apply("solarised-dracula-pro")
  assert.equal(result.applied, false)
  assert.equal(result.reason, "unknown")
  assert.equal(themeState.theme.name, DEFAULT_THEME.name, "配色不该被动过")
  assert.deepEqual(saves, [], "更不该把它存进配置")
})

test("确认时落盘，预览时不落盘", async () => {
  const themeState = makeState()
  const saves = []
  const config = makeConfig()
  const switcher = createThemeSwitcher({
    themeState,
    config,
    saveUiConfig: (values) => { saves.push(values) }
  })

  const preview = switcher.apply("light", { persist: false })
  assert.equal(themeState.theme.name, LIGHT_THEME.name, "预览要真的换色，否则看不出效果")
  assert.deepEqual(saves, [], "预览不该写配置 —— Esc 还原之后配置里会留着预览过的那个")
  assert.equal(config.ui.theme, null, "预览也不该改内存里的配置")
  assert.equal(preview.saved, null)

  const applied = switcher.apply("light")
  await applied.saved
  assert.deepEqual(saves, [{ theme: "light" }])
  assert.equal(config.ui.theme, "light", "本次会话立即一致，不用重启")
})

test("落盘失败不回滚画面，但要把错误交出去", async () => {
  const themeState = makeState()
  const switcher = createThemeSwitcher({
    themeState,
    config: makeConfig(),
    saveUiConfig: async () => { throw new Error("EACCES") }
  })
  const result = switcher.apply("light")
  const saved = await result.saved
  assert.equal(result.applied, true)
  assert.equal(themeState.theme.name, LIGHT_THEME.name, "写不进配置不是「这次没切成」")
  assert.equal(saved.error.message, "EACCES", "但也不能把错误吞了 —— 用户得知道下次启动记不住")
})

test("换肤后请求整屏重画", () => {
  let repaints = 0
  const themeState = makeState()
  const switcher = createThemeSwitcher({
    themeState,
    config: makeConfig(),
    requestFullRepaint: () => { repaints += 1 }
  })
  switcher.apply("light")
  switcher.apply("dark", { persist: false })
  assert.equal(repaints, 2, "预览也要重画，否则「选中即预览」什么都看不见")
})

test("默认的 mode_colors 不覆盖主题自带的航道色", () => {
  // DEFAULT_CONFIG 里那四个航道色是给黑底调的荧光色，且**总是存在**。
  // 无条件合并的话浅色主题的 modes 永远轮不到生效。
  const themeState = makeState()
  createThemeSwitcher({ themeState, config: makeConfig() }).apply("light")
  assert.deepEqual(themeState.theme.modes, LIGHT_THEME.modes)
})

test("用户改过的 mode_colors 跨主题保留", () => {
  const themeState = makeState()
  const config = makeConfig({
    mode_colors: { ...DEFAULT_CONFIG.ui.mode_colors, agent: "#123456" }
  })
  createThemeSwitcher({ themeState, config }).apply("light")
  assert.equal(themeState.theme.modes.agent, "#123456", "自定义航道色是用户显式设的，换肤不该抹掉")
  assert.equal(themeState.theme.modes.plan, LIGHT_THEME.modes.plan, "没改过的仍旧跟随主题")
})

test("往返还原在 themeState.theme 与 DEFAULT_THEME 共享对象时也完整（0.7.5 事故回归）", async () => {
  // 真实 wiring 里无 theme_file 的会话 themeState.theme 就是 DEFAULT_THEME 的
  // 共享引用。预览 light 会把它写脏 —— dark 基线若不是加载时定格的快照，
  // 还原时 replaceInPlace(脏, 它自己) 什么都不变，画面停在 light。
  const { DEFAULT_THEME } = await import("../src/theme/default-theme.mjs")
  const themeState = { theme: DEFAULT_THEME, detectedBackground: null }   // 刻意共享！
  const sw = createThemeSwitcher({ themeState, config: { ui: {} } })
  const fgBaseline = "#f5f7fa"
  assert.equal(themeState.theme.base.fg, fgBaseline, "前置：基线是 dark 的前景色")

  sw.apply("light", { persist: false })
  assert.notEqual(themeState.theme.base.fg, fgBaseline, "预览生效")

  sw.apply("dark", { persist: false })
  assert.equal(themeState.theme.base.fg, fgBaseline,
    "还原必须回到 dark —— 即使 DEFAULT_THEME 已被预览写脏")
  // 顺带把全局污染修干净（本测试自身的清理）：
  assert.equal(DEFAULT_THEME.base.fg, fgBaseline, "DEFAULT_THEME 也应被这次 apply(dark) 洗回来")
})
