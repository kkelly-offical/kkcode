/**
 * 命令 action → 打开对应的选择器浮层。
 *
 * 此前是 submitCurrentInput 里六个连续的 `if (action.openXxxPicker)` —— 一张
 * 靠记忆维护的手写清单：0.7.5 加 themePicker 时就是在那里多写一个 if，把回合
 * 状态机的判定点顶破了棘轮（86 → 87）。收敛到这里之后，加第七个选择器只改
 * 这张表，submitCurrentInput 一个字都不用动。
 *
 * 顺序即优先级：一个 action 理论上可以带多个 open 标志（现实中不会），先命中
 * 先开 —— 浮层互斥（ui-state 的 openUserOverlay）会保证最终只有一个开着。
 */
const PICKER_ACTIONS = [
  ["openModelPicker", (action, open) => open.openModelPicker(action.modelPickerItems)],
  ["openProviderPicker", (action, open) => open.openProviderPicker(action.providerPickerItems)],
  ["openSessionPicker", (action, open) => open.openSessionPicker(action.sessionPickerItems)],
  ["openPolicyPicker", (_action, open) => open.openPolicyPicker()],
  ["openModePicker", (_action, open) => open.openModePicker()],
  ["openThemePicker", (_action, open) => open.openThemePicker()]
]

export function applyPickerActions(action, openers) {
  if (!action) return
  for (const [flag, run] of PICKER_ACTIONS) {
    if (action[flag]) run(action, openers)
  }
}
