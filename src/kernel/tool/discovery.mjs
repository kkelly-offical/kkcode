/** Canonical advertising only: aliases stay registered and executable. */
export const TOOL_ALIASES = Object.freeze({ background_output: 'task_output', task_get: 'task_output', background_cancel: 'task_stop', patch: 'edit', multiedit: 'edit' })
const DEFERRED_BUILTINS = new Set(['artifact_read', 'artifact_search', 'tool_batch', 'tool_program', 'sysinfo', 'codesearch', 'http_request', 'websearch', 'webfetch', 'browser', 'browser_bridge', 'lsp', 'mcp_resource', 'mcp_prompt', 'notebookedit', 'move', 'copy', 'remove', 'mkdir', 'archive', 'git_status', 'git_info', 'git_snapshot', 'git_restore', 'git_list_snapshots', 'git_apply_patch', 'git_delete_snapshot', 'git_cleanup', 'task_list', 'task_parallel', 'task_output', 'task_stop'])
for (const name of ['office_capabilities', 'office_inspect', 'office_create', 'office_edit', 'office_render', 'office_pdf', 'office_ocr']) DEFERRED_BUILTINS.add(name)
DEFERRED_BUILTINS.add('browser_recipe')

function terms(value) {
  const text = String(value || '').slice(0, 8192).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  const words = Array.from(text.match(/[\p{L}\p{N}]+/gu) || [])
  for (const part of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    const chars = Array.from(part)
    for (let i = 1; i < chars.length; i++) words.push(chars[i - 1] + chars[i])
  }
  return words
}

/** Deterministic BM25 over metadata; never executes a discovered tool. */
export function searchToolMetadata(tools, query, limit = 5) {
  const exactName = String(query || '').trim().toLowerCase()
  const queryTerms = [...new Set(terms(query))].slice(0, 32)
  if (!queryTerms.length) return []
  const documents = tools.map(tool => {
    const words = terms(`${tool.name} ${tool.name} ${tool.description} ${Object.keys(tool.inputSchema?.properties || {}).join(' ')}`)
    const frequencies = new Map()
    for (const word of words) frequencies.set(word, (frequencies.get(word) || 0) + 1)
    return { tool, length: words.length, frequencies }
  })
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1) || 1
  const idf = new Map(queryTerms.map(term => {
    const matches = documents.filter(doc => doc.frequencies.has(term)).length
    return [term, Math.log(1 + (documents.length - matches + 0.5) / (matches + 0.5))]
  }))
  return documents.map(doc => ({ ...doc.tool, score: queryTerms.reduce((score, term) => {
    const frequency = doc.frequencies.get(term) || 0
    return score + (idf.get(term) * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / average)))
  }, 0) })).filter(tool => tool.score > 0)
    .sort((a, b) => Number(b.name.toLowerCase() === exactName) - Number(a.name.toLowerCase() === exactName) || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)))
}

/** @param {any[]} tools @param {{activated?: Set<string>, config?: Record<string, any>, allowedTools?: string[] | null}} [options] */
export function modelToolSurface(tools, { activated = new Set(), config = {}, allowedTools = null } = {}) {
  const eligible = allowedTools ? tools.filter(tool => allowedTools.includes(tool.name)) : tools
  const threshold = Math.max(1, Number(config.tool?.discovery?.threshold ?? 24))
  const deferred = eligible.some(tool => tool.name === 'tool_search') && config.tool?.discovery?.enabled !== false && eligible.filter(tool => tool.name.startsWith('mcp_')).length >= threshold
  const deferBuiltins = eligible.some(tool => tool.name === 'tool_search') && config.tool?.discovery?.enabled !== false
  return eligible.filter(tool => {
    if (config.tool?.legacy_aliases !== true && TOOL_ALIASES[tool.name]
      && eligible.some(other => other.name === TOOL_ALIASES[tool.name])) return false
    if (activated.has(tool.name)) return true
    if (deferBuiltins && DEFERRED_BUILTINS.has(tool.name)) return false
    return !deferred || !tool.name.startsWith('mcp_')
  })
}
