import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/index.mjs'
import { toPublicResult } from '../src/cli/output-format.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

async function fixture(t, responses, stream) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-empty-response-')), previous = process.env.KKCODE_HOME
  const cleanup = createFixtureCleanup(t); cleanup.remove(root)
  cleanup.defer(() => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous })
  process.env.KKCODE_HOME = path.join(root, 'state')
  const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true } })
  cleanup.defer(() => kernel.shutdown())
  const config = kernel.configState.config
  Object.assign(config, { language: 'zh', skills: { enabled: false, auto_seed: false }, mcp: { auto_discover: false }, git_auto: { enabled: false, auto_snapshot: false } })
  config.provider = { default: 'empty_fixture', empty_fixture: { default_model: 'fixture', stream, retry_attempts: 5 } }
  config.agent.max_steps = 5; config.agent.verify_completion = true; config.session.title_generation = false
  config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
  config.permission = { level: 'accept-edits', rules: [] }
  let calls = 0
  const next = () => responses[Math.min(calls++, responses.length - 1)]
  kernel.providers.registerProvider('empty_fixture', {
    async request() { return { usage: { input: 10, output: 2 }, stopReason: 'end_turn', toolCalls: [], ...next() } },
    async *requestStream() {
      const response = next()
      if (response.reasoning) yield { type: 'thinking', content: response.reasoning }
      if (response.text) yield { type: 'text', content: response.text }
      for (const call of response.toolCalls || []) yield { type: 'tool_call', call }
      yield { type: 'usage', usage: response.usage || { input: 10, output: 2 } }
      yield { type: 'stop', reason: response.stopReason || 'end_turn' }
    }
  })
  const events = []
  kernel.events.subscribe(event => events.push(event))
  return { root, kernel, events, calls: () => calls,
    execute: () => kernel.executeTurn({ sessionId: 'empty-case', prompt: '执行此处的受控测试', mode: 'agent', providerType: 'empty_fixture', model: 'fixture' }) }
}

for (const stream of [false, true]) test(`${stream ? 'stream' : 'nonstream'} whitespace cannot justify automatic continuation after max_tokens`, async t => {
  const f = await fixture(t, [{ text: ' \n\t ', reasoning: ' \t ', stopReason: 'max_tokens' }], stream)
  const result = await f.execute()
  assert.equal(f.calls(), 1, 'blank output is not a recoverable partial answer')
  assert.equal(toPublicResult(result).status, 'failed')
  assert.match(result.error, /本轮未完成/)
  assert.equal(f.events.filter(event => event.type === 'turn.finish').length, 0)
})

for (const stream of [false, true]) for (const response of [{ text: '' }, { text: ' \n\t ' }, { text: '', reasoning: '公开测试思考片段' }]) {
  test(`${stream ? 'stream' : 'nonstream'} empty ${response.reasoning ? 'reasoning-only' : JSON.stringify(response.text)} is a failed turn, not synthetic success`, async t => {
    const f = await fixture(t, [response], stream), result = await f.execute()
    assert.equal(f.calls(), 1, 'no unrequested retry or completion-verification request')
    assert.equal(toPublicResult(result).status, 'failed')
    assert.match(result.error, /本轮未完成/)
    assert.match(result.error, /没有执行工具/)
    const reported = f.events.filter(event => event.type === 'turn.usage.update').at(-1)?.payload.usage
    assert.equal(reported.input, 10)
    assert.equal(reported.output, 2)
    assert.equal(f.events.filter(event => event.type === 'turn.error').length, 1)
    assert.equal(f.events.filter(event => event.type === 'turn.finish').length, 0)
    const session = await f.kernel.sessions.getSession('empty-case')
    assert.equal(session.session.retryMeta.inProgress, false)
    assert.equal(session.session.status, 'error')
    assert.ok(!JSON.stringify(session.messages).includes('No content returned'))
    if (response.reasoning) assert.ok(JSON.stringify(session.messages).includes(response.reasoning), 'keep the actual reasoning without inventing a final answer')
  })
}

test('an empty report after a real write preserves the effect and does not repeat the tool', async t => {
  const f = await fixture(t, [
    { text: '', toolCalls: [{ id: 'one-write', name: 'write', args: { path: 'effect.txt', content: 'once', mode: 'append' } }] },
    { text: '', reasoning: '准备汇报，但服务未返回正文' }
  ], false)
  const result = await f.execute()
  assert.equal(f.calls(), 2)
  assert.equal(await readFile(path.join(f.root, 'effect.txt'), 'utf8'), 'once')
  assert.equal(result.toolEvents.length, 1)
  assert.equal(result.toolEvents[0].status, 'completed')
  assert.equal(toPublicResult(result).status, 'failed')
  assert.match(result.error, /先核对工具结果及文件改动/)
  assert.match(result.error, /不会自动重放/)
})
