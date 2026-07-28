/**
 * 运行时切主题。
 *
 * ## 为什么是「就地改内容」而不是「换一个对象」
 *
 * `ctx.themeState.theme` 这个**对象**在启动时就被好几处拿走存住了 ——
 * `createActivityRenderer({ theme: ctx.themeState.theme })`（repl.mjs:698）、
 * 行模式的 `createActivityRenderer`（:386）都是构造时收下引用、之后一直用它。
 * 把 `themeState.theme` 指向一个新对象，只有每帧重读 `ctx.themeState.theme` 的
 * frame-builder 会跟着变，那几处仍旧画着旧配色 —— 半屏新色半屏旧色。
 *
 * 所以这里**替换的是那个对象的内容**：键删干净再逐层写入新调色板，对象身份不变，
 * 于是所有持有引用的地方一起生效。
 *
 * `theme/markdown.mjs` 是个例外：它在 `setMarkdownColors` 时把颜色**复制**进模块
 * 级变量，不持有引用。所以每次换肤都要再调一次 —— 漏掉的表现是正文变了、代码块
 * 与标题还是旧配色。
 *
 * ## 已经画出去的行不会变色
 *
 * 对话记录里存的是**已经上过色的 ANSI 串**。换肤只影响此后渲染的内容，历史行
 * 保持原样。要让历史也变色得存原文重画，那是另一件事（且会丢掉流式期间的着色）。
 *
 * ## mode_colors 只有用户改过的才覆盖主题
 *
 * `loadTheme` 会把 `config.ui.mode_colors` 合并进 `theme.modes`。但那份配置**总是
 * 存在**（DEFAULT_CONFIG 里就有四个深色底的荧光色），无条件合并的话切到 light
 * 之后四个航道色仍是给黑底调的荧光色，浅色主题自带的 modes 永远轮不到生效。
 * 所以这里只取「与默认值不同」的那几个 —— 那才是用户真的改过的。
 */

import { DEFAULT_THEME } from "../theme/default-theme.mjs"

/**
 * dark 的基线快照，模块加载时定格。
 *
 * 不能每次都拿 DEFAULT_THEME 现值当 dark：无 theme_file 的会话里
 * `themeState.theme` 与 DEFAULT_THEME 共享对象，预览 light 会把它写脏 ——
 * 那之后「dark」就再也不存在了。加载时快照先于一切 apply，永远干净。
 */
const DARK_BASELINE = structuredClone(DEFAULT_THEME)
import { LIGHT_THEME } from "../theme/light-theme.mjs"
import { DEFAULT_CONFIG } from "../config/defaults.mjs"
import { setMarkdownColors } from "../theme/markdown.mjs"

/** 内置的三项。文件主题（若配置了 ui.theme_file）由 list() 追加在后面。 */
export const BUILTIN_THEME_CHOICES = Object.freeze([
  Object.freeze({ id: "dark", label: "dark", desc: "深色背景（默认）" }),
  Object.freeze({ id: "light", label: "light", desc: "浅色背景" }),
  Object.freeze({ id: "auto", label: "auto", desc: "跟随终端背景（OSC 11 探测）" })
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** 把 source 的内容写进 target，**保持 target 的对象身份**。多余的键要删掉。 */
function replaceInPlace(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key]
  }
  for (const [key, value] of Object.entries(source)) {
    if (!isPlainObject(value)) {
      target[key] = value
      continue
    }
    if (!isPlainObject(target[key])) target[key] = {}
    replaceInPlace(target[key], value)
  }
}

/** 用户真的改过的航道色（与 DEFAULT_CONFIG 不同的那几个）。见文件头。 */
function customModeColors(config) {
  const configured = config?.ui?.mode_colors
  if (!isPlainObject(configured)) return {}
  const baseline = DEFAULT_CONFIG.ui.mode_colors
  const custom = {}
  for (const [mode, color] of Object.entries(configured)) {
    if (color && color !== baseline[mode]) custom[mode] = color
  }
  return custom
}

/** `ui.theme_file` 的文件名（去掉目录），当作这份主题的 id。 */
function themeFileId(config) {
  const file = config?.ui?.theme_file
  if (typeof file !== "string" || !file.trim()) return null
  const name = file.trim().replace(/\\/g, "/").split("/").filter(Boolean).pop()
  return name || null
}

/**
 * @param {object} p
 * @param {{theme: object, source?: string, detectedBackground?: "light"|"dark"|null}} p.themeState
 * @param {object} p.config                 configState.config（读 ui.theme / ui.theme_file / ui.mode_colors）
 * @param {Function} [p.saveUiConfig]       (values) => Promise，落盘 ui.* ；不传则只在本次会话生效
 * @param {Function} [p.requestFullRepaint] 换肤后强制重画整屏
 */
export function createThemeSwitcher({ themeState, config, saveUiConfig = null, requestFullRepaint = () => {} }) {
  // 文件主题的快照。启动时 loadTheme 已经把文件读进 themeState.theme 了，所以
  // 这里不必也不该再读一次盘 —— 但必须在**任何一次 apply 之前**存下来，且要
  // 存在 themeState 上：`/theme` 命令在行模式下会临时造一个切换器，第二次造的
  // 时候 themeState.theme 可能已经是 light 了，那时再快照就把 light 当成文件主题了。
  const fileId = themeFileId(config)
  if (fileId && themeState.source && themeState.source !== "default" && !themeState.fileTheme) {
    themeState.fileTheme = structuredClone(themeState.theme)
  }
  // 文件配置了却没加载成功（不存在 / 不合法，loadTheme 会静默回落）时不进列表 ——
  // 列一个选了之后什么都不会变的项，比不列它更让人困惑。
  const fileTheme = fileId ? themeState.fileTheme || null : null

  /** 当前生效的主题 id。配置没写过就按「有文件主题用文件、否则 dark」推断。 */
  function current() {
    const configured = config?.ui?.theme
    if (typeof configured === "string" && configured.trim()) return configured.trim()
    if (fileTheme) return fileId
    return "dark"
  }

  function list() {
    const active = current()
    const rows = BUILTIN_THEME_CHOICES.map((choice) => ({ ...choice }))
    if (fileTheme) {
      rows.push({ id: fileId, label: fileId, desc: `主题文件 · ${fileTheme.name || "custom"}` })
    }
    return rows.map((row) => ({ ...row, current: row.id === active }))
  }

  /** id → 调色板。auto 在**每次 apply 时**重读探测结果，而不是构造时定死。 */
  function resolvePalette(name) {
    if (name === "dark") return DARK_BASELINE
    if (name === "light") return LIGHT_THEME
    if (name === "auto") return themeState.detectedBackground === "light" ? LIGHT_THEME : DARK_BASELINE
    if (fileTheme && name === fileId) return fileTheme
    return null
  }

  /**
   * 切到 name。
   *
   * @param {string} name
   * @param {{persist?: boolean}} [options] persist=false 用于浮层里的「选中即预览」：
   *   改画面但不写配置，Esc 还原时才不会把预览的那个存下来。
   * @returns {{applied: boolean, name: string, reason?: string, saved: Promise|null}}
   */
  function apply(name, { persist = true } = {}) {
    const resolved = resolvePalette(name)
    if (!resolved) return { applied: false, name, reason: "unknown", saved: null }

    /**
     * source 必须是快照，不能直接用 resolvePalette 的返回值。
     *
     * 事故（0.7.5 验收时抓到）：`themeState.theme` 在无 theme_file 的会话里与
     * `DEFAULT_THEME` **共享对象**（loadTheme 的 deepMerge 复用子树）。于是
     * 「预览 light」把 DEFAULT_THEME 全局涂成了 light；Esc 还原时
     * `resolvePalette("dark")` 返回的正是这个已被涂脏的对象 ——
     * replaceInPlace(脏, 它自己) 什么都不变，画面就停在 light。
     * 症状极具迷惑性：**部分**段位看起来还原了（那些恰好两套主题同值的键）。
     */
    const palette = structuredClone(resolved)
    const custom = customModeColors(config)
    replaceInPlace(themeState.theme, { ...palette, modes: { ...palette.modes, ...custom } })
    // markdown 那边存的是副本，不是引用 —— 不补这一刀，正文变了而代码块没变
    setMarkdownColors(themeState.theme.markdown)

    let saved = null
    if (persist) {
      // 本次会话立即一致：current() 与状态栏都读 config.ui.theme
      if (isPlainObject(config?.ui)) config.ui.theme = name
      if (saveUiConfig) {
        // 落盘失败不该把界面回滚 —— 画面已经切好了，只是下次启动不记得
        saved = Promise.resolve(saveUiConfig({ theme: name })).catch((error) => ({ error }))
      }
    }
    requestFullRepaint()
    return { applied: true, name, saved }
  }

  return { list, apply, current }
}


/**
 * OSC 11 探测响应 → themeState.detectedBackground（+ auto 主题即时应用）。
 *
 * 从 startTuiRepl 的解码链回调里搬出来的：那个闭包被判定点棘轮盯着（0.6.28 起
 * 只减不增），而这段逻辑只依赖显式传入的三样东西，没理由住在闭包里。
 */
export function createBackgroundProbeHandler({ themeState, config, themeSwitcher, parse, isLight }) {
  return (payload) => {
    const rgb = parse(`\u001b]11;${payload}\u0007`)
    if (!rgb) return
    themeState.detectedBackground = isLight(rgb) ? "light" : "dark"
    // 配置是 auto 时，探测结果一到就应用 —— 第一帧可能还是缺省暗色，
    // 150ms 内切过来比让用户手动 /theme 强
    if ((config.ui?.theme || "dark") === "auto") {
      themeSwitcher.apply("auto", { persist: false })
    }
  }
}
