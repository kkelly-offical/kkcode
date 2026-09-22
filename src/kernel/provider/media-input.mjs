import { ProviderError } from '../core/errors.mjs'
import { AUDIO_FORMATS, mediaBlockError } from '../core/media.mjs'

export function mediaInputSupport(capabilities, kind, protocol = 'openai') {
  if (kind === 'image') return capabilities?.image !== false
  if (!['audio', 'video'].includes(kind) || protocol !== 'openai') return false
  return typeof capabilities?.[kind] === 'boolean' ? capabilities[kind] : null
}

export function assertMediaInput(block, { capabilities = {}, protocol = 'openai', provider = '', model = '' } = {}) {
  const kind = block?.type
  if (!['image', 'audio', 'video'].includes(kind)) return
  const support = mediaInputSupport(capabilities, kind, protocol)
  if (support !== true) {
    const reason = protocol !== 'openai' && kind !== 'image'
      ? `${protocol} does not encode ${kind} input; choose an OpenAI-compatible channel supporting this media type`
      : support === null ? `${kind} support is unknown; discover the model capabilities or explicitly configure provider.model_capabilities`
        : `model "${model}" does not support ${kind} input; remove the attachment or switch models`
    throw new ProviderError(reason, { provider, model, reason: 'unsupported_capability', capability: kind })
  }
  const error = mediaBlockError(block)
  if (error) throw new ProviderError(error, { provider, model, reason: 'invalid_media', capability: kind })
}

/** OpenAI Chat audio + compatible video_url extension, not a claim that every endpoint supports video. */
export function mapOpenAIMedia(block) {
  const error = mediaBlockError(block)
  if (error) throw new ProviderError(error, { reason: 'invalid_media', capability: block.type })
  const mime = String(block.mediaType).toLowerCase()
  if (block.type === 'audio') return { type: 'input_audio', input_audio: { data: block.data, format: AUDIO_FORMATS[mime] } }
  if (block.type === 'video') return { type: 'video_url', video_url: { url: `data:${mime};base64,${block.data}` } }
  return null
}
