export const DEFAULT_THEME = {
  name: "neo-contrast",
  base: {
    bg: "#0b0b0b",
    fg: "#f5f7fa",
    muted: "#c3d2e8",
    border: "#5b6b85",
    accent: "#22d3ee"
  },
  semantic: {
    info: "#60a5fa",
    warn: "#fbbf24",
    error: "#f87171",
    success: "#34d399"
  },
  modes: {
    assistant: "#22d3ee",
    plan: "#2dd4bf",
    agent: "#4ade80",
    longagent: "#fb923c"
  },
  components: {
    panel: "#111827",
    header: "#e2e8f0",
    footer: "#94a3b8",
    diff_add: "#22c55e",
    diff_del: "#ef4444"
  },
  // 0.6.0 新增的三组。**全部可选** —— schema 只在键存在时校验，
  // 否则用户已有的 .theme.yaml 会突然「不合法」并静默回落默认主题。
  roles: {
    user: "#e2e8f0",       // 用户输入回显（此前硬编码在 repl.mjs 里）
    assistant: "#dbe4f0",  // 模型回复正文
    system: "#94a3b8"      // 系统提示
  },
  markdown: {
    heading1: "#f5f7fa",
    heading2: "#cbd5e1",
    heading3: "#a5b4c8",
    text: null,            // null = 正文不着色，跟随终端前景
    bold: "#f5f7fa",
    italic: "#cbd5e1",
    strike: "#7a8699",
    rule: "#5b6b85",
    code: "#22d3ee",
    codeBlock: "#a9b7c6",
    codeFence: "#555555",
    quote: "#8da3b9",
    listMarker: "#8a8a8a",
    link: "#78a9ff",
    linkTarget: "#777777",
    taskDone: "#78a889",
    tableBorder: "#606060",
    tableHeader: "#d0d0d0",
    // 代码块语法高亮
    syntaxComment: "#6b7a8f",
    syntaxString: "#a3d39c",
    syntaxKeyword: "#c792ea",
    syntaxNumber: "#f7a35c",
    syntaxFunction: "#82aaff",
    syntaxAdded: "#22c55e",
    syntaxRemoved: "#ef4444"
  },
  overlay: {
    selectedBg: "#60a5fa",
    selectedFg: "#111111"
  }
}
