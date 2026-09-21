import https from 'node:https'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const LAB_ATTACHMENT_TEXT = 'KKCODE_RELAY_ATTACHMENT: complete UTF-8 content — 文本附件真实送达模型。'
export const LAB_ATTACHMENT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lGkAAAAASUVORK5CYII='
const imageMetadata = block => {
  const source = block.type === 'image' ? block.source : null
  const inline = block.type === 'image_url' && /^data:(image\/[a-z]+);base64,(.+)$/.exec(block.image_url?.url || '')
  const encoded = source?.type === 'base64' ? source.data : inline?.[2]
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  return { mediaType: source?.media_type || inline?.[1], size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Deterministic HTTPS model fixture for fault/approval tests, never a shipped model catalog. */
export async function startLabProvider(lab) {
  const requests = []
  const server = https.createServer({ key: await readFile(path.join(lab.directory, 'tls.key')), cert: await readFile(path.join(lab.directory, 'tls.crt')) }, async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url.endsWith('/models')) {
      requests.push({ method: 'models', anthropic: Boolean(request.headers['x-api-key']) })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'lab-model-a', context_length: 32768 }, { id: 'lab-model-b', context_length: 32768 }], has_more: false })); return
    }
    let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 2 * 1024 * 1024) { response.writeHead(413); response.end(); return } }
    let body; try { body = JSON.parse(raw) } catch { response.writeHead(400); response.end('{}'); return }
    if (request.url.endsWith('/messages/count_tokens')) {
      requests.push({ method: 'token_count', model: body.model, anthropic: true })
      response.end(JSON.stringify({ input_tokens: 100 })); return
    }
    const messages = body.messages || [], last = messages.at(-1) || {}
    const text = typeof last.content === 'string' ? last.content : (last.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')
    const toolReturned = last.role === 'tool' || Array.isArray(last.content) && last.content.some(item => item.type === 'tool_result')
    const anthropic = request.url.endsWith('/messages')
    const blocks = Array.isArray(last.content) ? last.content : []
    const tag = ['LAB_ATTACHMENT_RELAY', 'LAB_PERMISSION_PRESERVED', 'LAB_ANDROID_NATIVE'].find(value => text.includes(value))
    requests.push({ method: 'inference', model: body.model, anthropic, toolReturned, tag, attachmentTextReceived: blocks.some(block => block.type === 'text' && block.text === LAB_ATTACHMENT_TEXT), images: blocks.map(imageMetadata).filter(Boolean) })
    let tool = null, args = {}, answer = toolReturned ? 'LAB_TOOL_OK' : text.includes('LAB_ATTACHMENT_RELAY') ? 'LAB_ATTACHMENT_OK' : text.includes('LAB_ANDROID_NATIVE') ? 'LAB_ANDROID_OK' : text.includes('LAB_BROWSER') ? 'LAB_BROWSER_OK' : 'LAB_HELLO_OK'
    if (!toolReturned && text.includes('LAB_APPROVAL')) { tool = 'write'; args = { path: 'approved.txt', content: 'remote synchronized\n' } }
    if (!toolReturned && text.includes('LAB_QUESTION')) { tool = 'question'; args = { questions: [{ id: 'choice', text: '请选择测试动作', options: [{ label: '继续测试', value: 'continue' }, { label: '停止', value: 'stop' }], allowCustom: true }] } }
    if (!toolReturned && text.includes('LAB_PERMISSION_PRESERVED')) { tool = 'write'; args = { path: 'must-not-write.txt', content: 'readonly policy must deny this write\n' } }
    if (text.includes('LAB_WAIT')) await new Promise(resolve => setTimeout(resolve, 3000))
    const id = `fixture-${requests.length}`
    if (anthropic) response.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: tool ? [{ type: 'tool_use', id, name: tool, input: args }] : [{ type: 'text', text: answer }], stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 4, output_tokens: 8 } }))
    else response.end(JSON.stringify({ id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : answer, ...(tool ? { tool_calls: [{ id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 8 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `https://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
