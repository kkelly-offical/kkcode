import { sanitizeTerminalText } from '../theme/terminal-sanitize.mjs'

/** Root prompts need no label; delegated prompts must show who is asking. */
export function promptSourceLabel(request = {}) {
  if (!request.subagent && !request.parentSessionId && !(request.originSessionId && request.originSessionId !== request.sessionId)) return ''
  const label = request.sourceLabel || request.subagent || 'subagent'
  const id = request.sourceSessionId || request.originSessionId || request.sessionId || ''
  return sanitizeTerminalText(label === id ? `subagent: ${id}` : `${label}${id ? ` · ${id}` : ''}`).slice(0, 200)
}
