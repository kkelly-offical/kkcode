/** Apply a completed history rewind without executing it a second time. */
export function applyRewindToUi(result, { ui, transcript }) {
  if (!result?.ok) return false
  const items = transcript.getItems(), index = items.findLastIndex(item => item.kind === 'user')
  if (index >= 0) for (const item of items.slice(index)) transcript.removeLog(item.id)
  ui.input = result.prompt || ''
  ui.inputCursor = ui.input.length
  ui.scrollOffset = 0
  return true
}
