import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/kernel.mjs'

test('five-message long-reasoning Responses history continues through the real tool loop', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-long-reasoning-')), cwd = path.join(root, 'work')
  await mkdir(cwd); await writeFile(path.join(cwd, 'fixture.txt'), 'READ_EVIDENCE')
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME)
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const index = requests.length - 1, final = index >= 2
    const thought = final ? '' : 'r'.repeat([248257, 151821][index])
    const output = final ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CONTINUED_WITH_READ_EVIDENCE' }] }] : [
      { type: 'reasoning', id: `reason-${index}`, summary: [] },
      { type: 'function_call', call_id: `read-${index}`, name: 'read', arguments: JSON.stringify({ path: path.join(cwd, 'fixture.txt') }), status: 'completed' }
    ]
    const response = { id: `response-${index}`, status: 'completed', output, usage: { input_tokens: 1000, output_tokens: final ? 10 : [64264, 39844][index], output_tokens_details: { reasoning_tokens: final ? 0 : [64200, 39712][index] } } }
    res.setHeader('content-type', 'text/event-stream')
    if (thought) res.write(`event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: thought })}\n\n`)
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify({
    provider: { default: 'fixture', fixture: { type: 'openai-responses', api_key_env: '', base_url: `http://127.0.0.1:${server.address().port}/v1`, default_model: 'qwen-fixture', context_limit: 262144, max_tokens: 65536, retry_attempts: 0 } },
    mcp: { auto_discover: false }, skills: { auto_seed: false }, session: { recovery: false, title_generation: false }, permission: { level: 'readonly' }
  }))
  const kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true } })
  t.after(async () => { try { await kernel.shutdown() } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  } })
  const result = await kernel.executeTurn({ prompt: 'Read fixture.txt and report its marker; do not edit files.', mode: 'plan' })
  assert.equal(result.error, null, result.error)
  assert.match(result.reply, /CONTINUED_WITH_READ_EVIDENCE/)
  assert.equal(requests.length, 3, 'no duplicate dispatch or unnecessary summary request')
  assert.doesNotMatch(JSON.stringify(requests[2]), /r{10000}/)
  assert.equal(requests[2].input.filter(item => item.type === 'function_call_output').length, 2)
  const stored = await kernel.sessions.getSession(result.sessionId)
  assert.deepEqual(stored.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'reasoning').map(b => b.text.length) : []), [248257, 151821])
})
