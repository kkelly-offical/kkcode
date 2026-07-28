/**
 * 浅背景调色板。键结构与 `default-theme.mjs` **完全一致** ——
 * `test/theme-light.test.mjs` 递归比对两份主题的键集合，少一个键就红。
 *
 * 为什么不是「把深色主题的颜色反过来」：反色出来的中间调在白底上一律糊成一片
 * （深色主题的 muted `#c3d2e8` 反过来是 `#3c2d17`，那是棕色不是灰色）。所以这份
 * 是按浅底重新取的色，取色规则只有两条：
 *
 *   1. 正文与标题走近黑（#111827 / #1c1f24），muted 走中灰 `#5c6470`
 *      —— 白底上对比度 ≈ 5.9:1，够 WCAG AA 的正文档位；
 *   2. 语义色一律取 tailwind 的 600/700 档而不是 300/400 档。400 档是给深色底
 *      设计的，放到白底上对比度只有 2:1 左右，diff 的红绿会看不出区别 ——
 *      而 diff 恰恰是这个终端里最不能认错的两个颜色。
 *
 * diff 红绿在白底的对比度：`#15803d` ≈ 4.6:1、`#b91c1c` ≈ 6.0:1，且色相相距足够
 * 远，红绿色觉障碍下靠明度差也能区分（红比绿深一档是有意的）。
 */

export const LIGHT_THEME = {
  name: "paper-light",
  base: {
    bg: "#fafafa",
    fg: "#1c1f24",
    muted: "#5c6470",
    border: "#c3c9d1",
    accent: "#0e7490"
  },
  semantic: {
    info: "#1d4ed8",
    warn: "#b45309",
    error: "#b91c1c",
    success: "#15803d"
  },
  modes: {
    assistant: "#0e7490",
    plan: "#0f766e",
    agent: "#15803d",
    longagent: "#c2410c"
  },
  components: {
    panel: "#eef1f5",
    header: "#111827",
    footer: "#4b5563",
    diff_add: "#15803d",
    diff_del: "#b91c1c"
  },
  roles: {
    user: "#111827",       // 用户输入回显
    assistant: "#1f2937",  // 模型回复正文
    system: "#4b5563"      // 系统提示
  },
  markdown: {
    heading1: "#111827",
    heading2: "#1f2937",
    heading3: "#374151",
    text: null,            // null = 正文不着色，跟随终端前景
    bold: "#111827",
    italic: "#374151",
    strike: "#9ca3af",
    rule: "#cbd5e1",
    code: "#0e7490",
    codeBlock: "#1f2937",
    codeFence: "#9ca3af",
    quote: "#475569",
    listMarker: "#6b7280",
    link: "#1d4ed8",
    linkTarget: "#6b7280",
    taskDone: "#15803d",
    tableBorder: "#cbd5e1",
    tableHeader: "#111827",
    // 代码块语法高亮：白底上关键字用紫、字符串用深绿，两者与正文近黑都拉开明度
    syntaxComment: "#6b7280",
    syntaxString: "#15803d",
    syntaxKeyword: "#7c3aed",
    syntaxNumber: "#b45309",
    syntaxFunction: "#1d4ed8",
    syntaxAdded: "#15803d",
    syntaxRemoved: "#b91c1c"
  },
  overlay: {
    // 深色主题这里是「亮蓝底 + 近黑字」，白底要反过来：深蓝底 + 白字，
    // 否则选中行与未选中行的明度几乎一样，看不出选中在哪。
    selectedBg: "#1d4ed8",
    selectedFg: "#ffffff"
  }
}
