import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { normalizeImageBlock, prepareImageMessages, safeSvgBytes, IMAGE_LIMITS } from '../src/kernel/media/images.mjs'
import { createToolRegistry } from '../src/kernel/tool/registry.mjs'
import { executeTool } from '../src/kernel/tool/executor.mjs'
import { normalizeToolResult } from '../src/kernel/mcp/tool-result.mjs'
import { validateExistingFileMutation } from '../src/kernel/tool/mutation-guard.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { touchSession, appendMessage, flushNow } from '../src/kernel/session/store.mjs'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="red"/></svg>'
const block = source => ({ type: 'image', mediaType: 'image/svg+xml', data: Buffer.from(source).toString('base64') })
const config = { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-media-contract-')), cwd = path.join(root, 'work')
  await mkdir(cwd)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'private')
  t.after(async () => { await flushNow(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  return { root, cwd }
}

test('SVG source → edit eligibility → explicit decoded PNG preview never rewrites the source', async t => {
  const { cwd } = await fixture(t), file = path.join(cwd, 'diagram.svg')
  await writeFile(file, svg)
  const registry = createToolRegistry(); await registry.initialize({ config, cwd, allowProjectSources: false })
  const read = await registry.get('read')
  const source = await read.execute({ path: file, encoding: 'utf8' }, { cwd, config })
  assert.match(source, /1→<svg/)
  assert.equal((await validateExistingFileMutation({ targetPath: file, operation: 'editing', anchor: 'fill="red"' })).ok, true)
  const preview = await executeTool({ tool: read, args: { path: file, view: 'image' }, sessionId: 'fixture', turnId: 'preview', context: { cwd, config } })
  assert.equal(preview.ok, true); assert.equal(preview.image.mediaType, 'image/png')
  const decoded = await sharp(Buffer.from(preview.image.data, 'base64')).raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 100); assert.equal(decoded.data[0], 255); assert.equal(decoded.data[1], 0)
  assert.equal(await readFile(file, 'utf8'), svg)
})

test('static SVG renderer rejects scripts, CSS/external references, entities and oversized nesting', async () => {
  for (const source of [
    '<svg><script>alert(1)</script></svg>', '<svg><foreignObject/></svg>',
    '<svg><image href="file:///etc/passwd"/></svg>', '<svg><use href="https://example.com/x.svg#x"/></svg>',
    '<svg><use href="&#104;ttps://example.com/x"/></svg>', '<svg><rect style="fill:url(file:///secret)"/></svg>',
    '<svg><style>@import "https://example.com/x"</style></svg>', '<svg onload="alert(1)"/>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg>&x;</svg>',
    `<svg>${'<g>'.repeat(70)}${'</g>'.repeat(70)}</svg>`
  ]) assert.throws(() => safeSvgBytes(Buffer.from(source)))
  assert.doesNotThrow(() => safeSvgBytes(Buffer.from('<svg><defs><linearGradient id="a"/></defs><rect fill="url(#a)"/></svg>')))
})

test('bad historical media is quarantined and valid historical SVG is rasterized without mutating history', async () => {
  const messages = [
    { role: 'user', synthetic: true, content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'SVG preview' }, block(svg)] },
    { role: 'user', synthetic: true, content: [{ type: 'image', mediaType: 'image/png', data: Buffer.from('not pixels').toString('base64') }] },
    { role: 'user', content: 'Can we continue?' }
  ]
  const before = JSON.stringify(messages), output = await prepareImageMessages(messages)
  assert.equal(output[0].content[1].mediaType, 'image/png')
  assert.match(output[1].content[0].text, /withheld/)
  assert.equal(output[2].content, 'Can we continue?'); assert.equal(JSON.stringify(messages), before)
  await assert.rejects(prepareImageMessages([{ role: 'user', content: [block(svg)] }]), /SVG/)
})

test('byte/pixel/base64 limits reject invalid images before any provider network request', async () => {
  await assert.rejects(normalizeImageBlock({ data: '!!!', mediaType: 'image/png' }), /base64/)
  await assert.rejects(normalizeImageBlock({ data: 'A'.repeat(Math.ceil(IMAGE_LIMITS.bytes / 3) * 4 + 4) }), /20 MiB/)
  await assert.rejects(normalizeImageBlock(block('<svg width="100000" height="100000"/>'), { allowSvg: true }))
  const bad = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')
  await assert.rejects(normalizeImageBlock({ data: bad, mediaType: 'image/png' }), /decoded/)
})

test('MCP text + multiple images + structured results survive executor into the model content contract', async t => {
  const { cwd } = await fixture(t)
  const png = (await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')
  const wire = { content: [{ type: 'text', text: 'Screenshot ready' }, { type: 'image', mimeType: 'image/png', data: png }, { type: 'image', mimeType: 'image/svg+xml', data: block(svg).data }], structuredContent: { verified: true } }
  const mcp = { initialize: async () => {}, listTools: () => [{ id: 'mcp_fixture_capture', server: 'fixture', description: 'Capture', inputSchema: { type: 'object' } }], callTool: async () => normalizeToolResult(wire, 'fixture', 'capture') }
  const registry = createToolRegistry({ mcpRegistry: mcp })
  await registry.initialize({ cwd, config: { tool: { sources: { builtin: false, local: false, plugin: false, mcp: true } } }, allowProjectSources: false })
  const result = await executeTool({ tool: await registry.get('mcp_fixture_capture'), args: {}, sessionId: 'fixture', turnId: 'mcp', context: { cwd, config } })
  assert.equal(result.contentBlocks.length, 2); assert.ok(result.contentBlocks.every(item => item.mediaType === 'image/png'))
  assert.match(result.output, /Screenshot ready/); assert.match(result.output, /"verified":true/)
})

test('preview references are session-bound, return raster pixels and never expose raw SVG or third-party URLs', async t => {
  const { cwd } = await fixture(t)
  await touchSession({ sessionId: 'fixture', cwd, title: 'fixture' })
  const message = await appendMessage('fixture', 'user', [block(svg)])
  await flushNow()
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  t.after(() => service.close())
  const principal = { id: 'local', client: 'fixture' }
  const view = await service.dispatch('sessions.get', { sessionId: 'fixture' }, principal)
  const reference = view.messages[0].content[0]
  assert.equal(reference.type, 'image_preview'); assert.equal(reference.data, undefined)
  const preview = await service.dispatch('media.preview', { sessionId: 'fixture', messageId: message.id, index: 0 }, principal)
  assert.equal(preview.mediaType, 'image/png')
  await assert.rejects(service.dispatch('media.preview', { sessionId: 'missing', messageId: message.id, index: 0 }, principal), { code: 'session_missing' })
  await assert.rejects(service.dispatch('media.preview', { sessionId: 'fixture', messageId: '../file', index: 0 }, principal), { code: 'invalid_preview' })
})
