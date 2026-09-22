/** Shared, bounded media contract. No filesystem, network or provider access. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024
export const AUDIO_FORMATS = Object.freeze({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' })
export const VIDEO_FORMATS = Object.freeze(['video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg'])

export function sniffMediaType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0)) return 'audio/mpeg'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'audio/mp4'
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 4096).includes(Buffer.from('webm'))) return 'video/webm'
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && [0xba, 0xb3].includes(bytes[3])) return 'video/mpeg'
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
  return null
}

/** Return an actionable error, never echo media bytes or private paths. */
export function mediaBlockError(block) {
  if (!['audio', 'video'].includes(block?.type)) return null
  const mime = String(block.mediaType || '').toLowerCase()
  if (block.type === 'audio' && !AUDIO_FORMATS[mime]) return 'Audio input requires WAV or MP3; convert the file before attaching it'
  if (block.type === 'video' && !VIDEO_FORMATS.includes(mime)) return 'Video input requires MP4, MOV, WebM or MPEG'
  if (typeof block.data !== 'string' || !block.data || block.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) return 'Media must contain base64 data and be at most 20 MiB'
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) return 'Invalid base64 media data'
  const bytes = Buffer.from(block.data, 'base64')
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) return 'Media must be non-empty and at most 20 MiB'
  const detected = sniffMediaType(bytes)
  const normalized = mime === 'audio/x-wav' ? 'audio/wav' : mime === 'audio/mp3' ? 'audio/mpeg' : mime
  if (detected !== normalized) return 'Media bytes do not match the declared file format'
  return null
}
