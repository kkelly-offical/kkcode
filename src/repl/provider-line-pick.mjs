/**
 * 行模式的 provider 编号选择：拦截输入态。
 *
 * 裸 `/provider` 在行模式（无 TTY，没有帧可浮）打一份编号列表并进入选择态；
 * 选择态期间的下一次输入在这里被拦截 —— 数字/名字完成切换，`/` 开头则退出
 * 选择态并放行给命令分发。TUI 不经过这里（选择器是浮层）。
 *
 * 抽自 repl.mjs 的 processInputLine：组装根有行数预算，这段自成一体。
 *
 * @returns {Promise<{handled: boolean, action?: object}>}
 *   handled=false 表示输入要按正常命令/提示词继续走（比如用户改主意敲了别的命令）
 */
export async function handleProviderLinePick({
  providerPicker,
  input,
  state,
  print,
  setProviderPicker,
  switchActiveProvider
}) {
  if (!providerPicker) return { handled: false }
  const list = providerPicker
  // 用户改主意敲了别的命令 —— 取消选择模式，让命令正常执行，
  // 而不是把 "/help" 当 provider 名去匹配然后报「找不到」
  if (input.startsWith("/")) {
    if (setProviderPicker) setProviderPicker(null)
    print("  已退出 provider 选择。")
    return { handled: false }
  }
  if (setProviderPicker) setProviderPicker(null)
  if (!input) { print("  已取消。"); return { handled: true, action: { exit: false } } }
  const num = Number(input)
  const target = (!isNaN(num) && num >= 1 && num <= list.length)
    ? list[num - 1]
    : list.find((p) => p === input)
  if (!target) {
    print(`  找不到 provider: "${input}"（可用: ${list.join(", ")}）`)
    return { handled: true, action: { exit: false } }
  }
  if (target === state.providerType) {
    print(`  "${target}" 已经是当前 provider。`)
    return { handled: true, action: { exit: false } }
  }
  await switchActiveProvider(target)
  return { handled: true, action: { exit: false } }
}
