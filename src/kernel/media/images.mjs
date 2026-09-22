import sharp from 'sharp'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { createHash } from 'node:crypto'
import { ProviderError } from '../core/errors.mjs'

export const IMAGE_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, pixels: 24 * 1024 * 1024, dimension: 2048, perRequest: 16, cacheBytes: 16 * 1024 * 1024 })
const cache = new Map()
let cachedBytes = 0
const svgElements = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern filter feGaussianBlur feOffset feMerge feMergeNode feColorMatrix feBlend feFlood feComposite feComponentTransfer feFuncR feFuncG feFuncB feFuncA feMorphology feTurbulence feDisplacementMap feConvolveMatrix feDiffuseLighting feSpecularLighting feDistantLight fePointLight feSpotLight'.split(' '))
const invalid = message => new ProviderError(message, { reason: 'invalid_image', capability: 'image' })

export function imageBytes(block) {
  let data = block?.data
  const uri = typeof data === 'string' && /^data:([^;,]+);base64,(.*)$/s.exec(data)
  if (uri) data = uri[2]
  if (typeof data !== 'string' || !data || data.length > Math.ceil(IMAGE_LIMITS.bytes / 3) * 4) throw invalid('Image must contain base64 data and be at most 20 MiB')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw invalid('Invalid base64 image data')
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > IMAGE_LIMITS.bytes || bytes.toString('base64') !== data) throw invalid('Invalid or oversized image data')
  return bytes
}

/** Self-contained static SVG only. Never pass a filename/base URL to the renderer.
 * The parsed tree rejects scripts, CSS escapes/imports, entities, foreign content
 * and every non-fragment resource reference before librsvg sees any bytes. */
export function safeSvgBytes(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw invalid('SVG must use UTF-8') }
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) throw invalid('SVG preview refuses document entities and external stylesheets')
  let document
  try { document = new DOMParser({ onError: () => { throw new Error('Invalid XML') } }).parseFromString(text, 'image/svg+xml') }
  catch { throw invalid('SVG contains invalid XML; read it as text and correct the source first') }
  if (document.documentElement?.localName !== 'svg') throw invalid('Image is not an SVG document')
  let count = 0
  const visit = (node, depth = 0) => {
    if (++count > 20000 || depth > 64) throw invalid('SVG preview exceeds the element or nesting limit')
    if (node.nodeType === 1) {
      if (!svgElements.has(node.localName) || (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/2000/svg')) throw invalid('SVG preview supports static vector elements only; remove scripts, styles, embedded images and foreign content')
      for (let i = 0; i < node.attributes.length; i++) {
        const attribute = node.attributes.item(i), name = attribute.localName.toLowerCase(), value = attribute.value
        if (name.startsWith('on') || name === 'base' || /[\\@]/.test(value)) throw invalid('SVG preview refuses executable attributes, CSS imports and escaped resource references')
        if (['href', 'src'].includes(name) && !/^#[A-Za-z_][\w.:-]*$/.test(value.trim())) throw invalid('SVG preview refuses external or embedded resources; use local vector shapes')
        if (/url\s*\(/i.test(value) && !/^\s*url\(\s*['"]?#[A-Za-z_][\w.:-]*['"]?\s*\)\s*$/.test(value)) throw invalid('SVG preview permits only local fragment references')
      }
    } else if (![3, 4, 8, 9].includes(node.nodeType)) throw invalid('SVG preview refuses processing instructions and document types')
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, depth + 1)
  }
  visit(document.documentElement)
  return Buffer.from(new XMLSerializer().serializeToString(document.documentElement))
}

/** Decode, orient, bound and re-encode. Declared MIME/extension is never evidence
 * of valid pixels. Cached values are bounded immutable-by-copy DTOs, not files. */
export async function normalizeImageBlock(block, { allowSvg = false, maxDimension = IMAGE_LIMITS.dimension } = {}) {
  const bytes = imageBytes(block)
  const dimension = Math.max(32, Math.min(IMAGE_LIMITS.dimension, Number(maxDimension) || IMAGE_LIMITS.dimension))
  const key = createHash('sha256').update(bytes).update(`:${allowSvg}:${dimension}`).digest('hex')
  if (cache.has(key)) return { ...cache.get(key) }
  try {
    const sourceIsSvg = /image\/svg\+xml/i.test(String(block.mediaType || block.mimeType || '')) || bytes.toString('utf8').trimStart().startsWith('<')
    if (sourceIsSvg && !allowSvg) throw invalid('SVG is source text, not a native model image; use read with view="image" to render a safe PNG preview')
    const input = sourceIsSvg ? safeSvgBytes(bytes) : bytes
    const options = { failOn: /** @type {const} */ ('warning'), limitInputPixels: IMAGE_LIMITS.pixels, unlimited: false, animated: false }
    const metadata = await sharp(input, options).metadata()
    if (!['png', 'jpeg', 'gif', 'webp', ...(allowSvg && sourceIsSvg ? ['svg'] : [])].includes(metadata.format)) throw invalid('Image format is unsupported; convert it to PNG, JPEG, GIF or WebP')
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > IMAGE_LIMITS.pixels) throw invalid('Image dimensions exceed the safe decoding limit')
    const preserve = !sourceIsSvg && metadata.width <= dimension && metadata.height <= dimension && (metadata.pages || 1) === 1 && (!metadata.orientation || metadata.orientation === 1)
    let data, info
    if (preserve) {
      await sharp(input, options).timeout({ seconds: 5 }).raw().toBuffer() // Force pixel decoding, not only header inspection.
      data = bytes; info = { width: metadata.width, height: metadata.height }
    } else ({ data, info } = await sharp(input, options).timeout({ seconds: 5 }).rotate().resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true }))
    if (data.length > IMAGE_LIMITS.bytes) throw invalid('Decoded image exceeds 20 MiB; use a smaller preview')
    const result = { type: 'image', data: data.toString('base64'), mediaType: preserve ? `image/${metadata.format}` : 'image/png', width: info.width, height: info.height, ...(sourceIsSvg ? { originalMediaType: 'image/svg+xml' } : {}) }
    const cost = result.data.length
    if (cost <= IMAGE_LIMITS.cacheBytes) {
      while (cache.size && (cache.size >= 32 || cachedBytes + cost > IMAGE_LIMITS.cacheBytes)) { const oldest = cache.keys().next().value; cachedBytes -= cache.get(oldest).data.length; cache.delete(oldest) }
      cache.set(key, result); cachedBytes += cost
    }
    return { ...result }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw invalid('Image pixels could not be decoded safely; read SVG as source text, or provide a valid PNG/JPEG/WebP/GIF image')
  }
}

/** A request projection: never delete or mutate canonical conversation history.
 * Fresh invalid input is actionable; old invalid blocks become explicit notices.
 * Valid old SVG is rasterized, preserving the ability to continue the same chat. */
export async function prepareImageMessages(messages = []) {
  const output = [], total = messages.reduce((n, message) => n + (Array.isArray(message?.content) ? message.content.filter(block => block?.type === 'image').length : 0), 0)
  let remaining = total
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!Array.isArray(message?.content)) { output.push(message); continue }
    const fresh = index === messages.length - 1 && message.role === 'user' && !message.synthetic && !message.content.some(block => block?.type === 'tool_result')
    const content = []
    for (const block of message.content) {
      if (block?.type !== 'image') { content.push(block); continue }
      try {
        if (remaining-- > IMAGE_LIMITS.perRequest) throw invalid('Only the most recent 16 images are sent in one request')
        content.push(await normalizeImageBlock(block, { allowSvg: !fresh }))
      } catch (error) {
        if (fresh) throw error
        content.push({ type: 'text', text: `[Image withheld from model input: ${error.message}. Original attachment remains in conversation history.]` })
      }
    }
    output.push({ ...message, content })
  }
  return output
}
