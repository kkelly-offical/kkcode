import { normalizeImageBlock } from '../media/images.mjs'
import { mediaBlockError } from '../core/media.mjs'

/** One model-facing content contract for builtins, plugins and MCP. Resource
 * links are described, never fetched implicitly. Structured output stays useful
 * even when the server supplies an unrelated human-readable status message. */
export async function toolResultContent(raw, originalOutput) {
  const blocks = Array.isArray(raw?.content) ? [...raw.content] : []
  if (raw?.image?.data) blocks.push({ type: 'image', ...raw.image })
  else if (raw?.type === 'image' && raw.data) blocks.push(raw)
  const media = [], notices = [], seen = new Set()
  for (const item of blocks.slice(0, 64)) {
    if (!item || typeof item !== 'object') continue
    const block = { ...item, mediaType: item.mediaType || item.mimeType }
    if (['image', 'audio', 'video'].includes(item.type)) {
      if (media.length >= 8) { notices.push('[Additional tool media omitted: use a narrower request.]'); break }
      const identity = `${block.type}:${block.data}`
      if (seen.has(identity)) continue
      seen.add(identity)
      try {
        if (block.type === 'image') media.push(await normalizeImageBlock(block, { allowSvg: true }))
        else { const error = mediaBlockError(block); if (error) throw new Error(error); media.push({ type: block.type, data: block.data, mediaType: block.mediaType }) }
      } catch (error) { notices.push(`[Tool media unavailable: ${error.message}]`) }
    } else if (item.type === 'resource_link') notices.push(`Resource reference (not fetched): ${String(item.name || '').slice(0, 256)} ${String(item.uri || '').slice(0, 2048)}`)
    else if (item.type === 'resource' && typeof item.resource?.text === 'string') notices.push(`Resource ${String(item.resource.uri || '').slice(0, 2048)}:\n${item.resource.text.slice(0, 20000)}`)
    else if (item.type === 'resource' && item.resource?.blob) notices.push('[Embedded binary resource retained by the tool; request a supported media representation to inspect it.]')
  }
  if (raw?.structuredContent !== undefined) {
    try {
      const structured = JSON.stringify(raw.structuredContent)
      if (structured && !String(originalOutput).includes(structured)) notices.push(`Structured result:\n${structured.slice(0, 20000)}${structured.length > 20000 ? '\n[Structured result truncated]' : ''}`)
    } catch { notices.push('[Structured result could not be serialized]') }
  }
  return { output: [originalOutput, ...notices].filter(Boolean).join('\n'), contentBlocks: media }
}
