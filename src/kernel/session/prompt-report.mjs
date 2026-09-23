import { estimateStringTokens } from './compaction.mjs'
import { getSession } from './store.mjs'

/** Metadata only: never exports prompt text, tool arguments, or credentials. */
/** @param {any} system @param {any[]} tools @param {any} context @param {{turnId?: string, step?: number}} [identity] */
export function promptReport(system, tools, context, { turnId, step } = {}) {
  return {
    version: 1, turnId, step, capturedAt: Date.now(),
    context,
    blocks: (system?.blocks || []).map(block => ({
      label: block.label, source: block.source, fingerprint: block.fingerprint,
      cacheable: block.cacheable === true, estimatedTokens: estimateStringTokens(block.text || '')
    })),
    advertisedTools: tools.map(tool => tool.name),
    note: 'Actual last request assembly; block token counts are estimates. Prompt text and credentials are omitted.'
  }
}

export async function inspectPrompt(sessionId) {
  const data = await getSession(sessionId)
  if (!data) throw new Error('Session not found')
  return data.session.promptReport || { version: 1, note: 'No prompt diagnostic captured yet. Run a conversation turn with this version first.' }
}
