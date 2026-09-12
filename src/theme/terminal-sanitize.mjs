/**
 * 兼容别名（1.0.0 阶段 3a）：终端消毒原语已下沉到 src/core/terminal-sanitize.mjs
 * —— 它是无依赖的纯函数叶子，内核（session/）与前端（theme/、ui/、repl/）都
 * 需要它，而内核不允许 import theme/（M3 耦合点 14）。本文件只是 re-export，
 * 旧 import 路径继续工作；新代码按所在层选 ../core/ 或 ./terminal-sanitize.mjs。
 */
export {
  sanitizeTerminalText,
  sanitizeTerminalStyledText,
  sanitizeTerminalValue
} from "../kernel/core/terminal-sanitize.mjs"
