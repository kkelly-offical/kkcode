export const wavBytes = Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000', 'hex')
export const mp3Bytes = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary'), Buffer.alloc(12)])
// Container fixture for wire-shape tests, not an assertion of media decoding.
export const mp4Bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
export const wavBlock = { type: 'audio', mediaType: 'audio/wav', data: wavBytes.toString('base64') }
export const mp4Block = { type: 'video', mediaType: 'video/mp4', data: mp4Bytes.toString('base64') }
