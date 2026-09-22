import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { requestProvider, requestProviderStream } from '../src/kernel/provider/router.mjs'
import { requestAnthropic } from '../src/kernel/provider/anthropic.mjs'
import { enforceModelInputCapabilities } from '../src/kernel/provider/model-capabilities.mjs'
import { mediaInputSupport, mapOpenAIMedia } from '../src/kernel/provider/media-input.mjs'
import { mediaBlockError, MAX_MEDIA_BYTES } from '../src/kernel/core/media.mjs'
import { authoringCommands } from '../src/repl/commands/authoring.mjs'
import { wavBlock, mp4Block } from './helpers/media-fixtures.mjs'

test('fresh audio/video require an explicit capability and a compatible protocol', () => {
  for (const block of [wavBlock, mp4Block]) {
    for (const capabilities of [{}, { [block.type]: false }]) {
      assert.throws(() => enforceModelInputCapabilities({ messages: [{ role: 'user', content: [block] }], capabilities }), /support/)
    }
    for (const protocol of ['anthropic', 'ollama']) {
      assert.throws(() => enforceModelInputCapabilities({ messages: [{ role: 'user', content: [block] }], capabilities: { [block.type]: true }, protocol }), /does not encode/)
    }
    const good = enforceModelInputCapabilities({ messages: [{ role: 'user', content: [block] }], capabilities: { [block.type]: true } })
    assert.deepEqual(good.messages[0].content, [block])
    assert.equal(good.droppedMedia, 0)
  }
  assert.equal(mediaInputSupport({}, 'image'), true)
  assert.equal(mediaInputSupport({}, 'video'), null)
})

test('historical audio/video has explicit placeholders on an incompatible model, without mutating history', () => {
  const messages = [{ role: 'user', content: [wavBlock, mp4Block] }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'continue' }]
  const result = enforceModelInputCapabilities({ messages, protocol: 'anthropic' })
  assert.equal(result.droppedMedia, 2)
  assert.match(result.messages[0].content[0].text, /withheld from history/)
  assert.equal(messages[0].content[0].type, 'audio')
})

test('media format and size errors cannot silently become text', () => {
  for (const block of [
    { ...wavBlock, mediaType: 'audio/mp4' }, { ...mp4Block, mediaType: 'video/unknown' },
    { ...wavBlock, data: 'not base64' }, { ...wavBlock, data: 'dGV4dA==' },
    { ...wavBlock, data: 'A'.repeat(Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4) }
  ]) {
    assert.ok(mediaBlockError(block))
    assert.throws(() => mapOpenAIMedia(block), /Audio|Video|Media|media/)
  }
  assert.equal(mediaBlockError(wavBlock), null)
  assert.equal(mediaBlockError(mp4Block), null)
})

test('Anthropic direct adapter refuses audio before making a request', async () => {
  await assert.rejects(requestAnthropic({ apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1', model: 'fixture', messages: [{ role: 'user', content: [wavBlock] }] }), /does not encode audio/)
})

test('router sends real audio/video blocks in streaming and non-streaming HTTP request bodies', async t => {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"received"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'received' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const configState = { config: { provider: { default: 'fixture', fixture: { type: 'openai-compatible', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: '', default_model: 'media-model' }, model_capabilities: { 'media-model': { audio: true, video: true } } } }, source: { userRaw: {}, projectRaw: {} } }
  const input = { configState, providerType: 'fixture', model: 'media-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, wavBlock, mp4Block] }], tools: [], audit: false }
  assert.equal((await requestProvider(input)).text, 'received')
  for await (const event of requestProviderStream(input)) assert.ok(event)
  assert.equal(requests.length, 2)
  for (const body of requests) {
    const content = body.messages.find(message => message.role === 'user').content
    assert.equal(content[1].type, 'input_audio')
    assert.equal(content[1].input_audio.data, wavBlock.data)
    assert.equal(content[1].input_audio.format, 'wav')
    assert.equal(content[2].type, 'video_url')
    assert.equal(content[2].video_url.url, `data:video/mp4;base64,${mp4Block.data}`)
    assert.ok(!JSON.stringify(content).includes('withheld'))
  }
})

test('/paste rejection never claims success, including line mode and immediate-send mode', async () => {
  const paste = authoringCommands.find(command => command.names.includes('paste'))
  const messages = [], pendingImages = []
  const base = { args: '', print: message => messages.push(message), pendingImages, readClipboardMedia: async () => wavBlock }
  assert.deepEqual(await paste.run({ ...base, attachMedia: async () => null }), { exit: false })
  assert.ok(!messages.some(message => message.includes('attached')))
  const ctx = { configState: { config: { provider: { default: 'p', p: { type: 'openai-compatible', base_url: 'http://127.0.0.1:1' }, model_capabilities: { text: { audio: false } } } } } }
  for (const args of ['', 'transcribe']) {
    let sent = false
    await paste.run({ ...base, args, ctx, state: { providerType: 'p', model: 'text' }, runPromptTurn: async () => { sent = true } })
    assert.equal(sent, false)
    assert.deepEqual(pendingImages, [])
  }
  assert.ok(messages.some(message => /paste failed:/.test(message)))
})
