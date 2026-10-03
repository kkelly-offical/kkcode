/** Old host repair prompts remain in the canonical journal, but disabling the
 * optional gate must not replay them as new instructions on the next request. */
export function completionInputHistory(history, required) {
  if (required) return history
  return history.filter(message => !(message.role === 'user' && message.synthetic === true && message.contextKind === 'control'
    && typeof message.content === 'string' && /^\[(?:TASK VERIFICATION FAILED|任务验证失败|VERIFICATION FEEDBACK|检查反馈)\]/.test(message.content)))
}
