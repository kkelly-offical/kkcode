import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'

test('a full kernel turn advertises Browser, reviews a sensitive edit with the conversation model, persists review and includes usage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-auto-turn-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  let prompts = 0
  const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true }, handlers: { onPermissionPrompt: async () => { prompts++; return 'deny' } } })
  t.after(async () => { await kernel.shutdown(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const config = kernel.configState.config
  config.provider = { default: 'fixture', fixture: { default_model: 'conversation-model', stream: false, retry_attempts: 0 } }
  config.permission = { level: 'accept-edits', auto_review: true, rules: [] }
  config.agent.max_steps = 3; config.agent.verify_completion = false
  config.session.title_generation = false; config.skills.auto_seed = false; config.mcp.auto_discover = false
  config.git_auto = { enabled: false, auto_snapshot: false }
  config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
  let normal = 0, reviews = 0
  kernel.providers.registerProvider('fixture', { async request(input) {
    assert.equal(input.model, 'conversation-model')
    if (String(input.system).includes('review ONE proposed')) {
      reviews++; assert.deepEqual(input.tools, [])
      assert.match(JSON.stringify(input.messages), /AGENTS\.md/)
      return { text: '{"decision":"allow","reason":"用户要求创建该项目说明文件"}', toolCalls: [], usage: { input: 7, output: 3 } }
    }
    normal++; assert.ok(input.tools.some(tool => tool.name === 'browser'))
    return { text: normal === 1 ? '' : 'Created project instructions.', toolCalls: normal === 1 ? [{ id: 'write-instructions', name: 'write', args: { path: 'AGENTS.md', content: '# Project\nRun tests before delivery.\n' } }] : [], stopReason: normal === 1 ? 'tool_use' : 'end_turn', usage: { input: 1, output: 1 } }
  }, async *requestStream() { throw new Error('No stream in fixture') } })
  const result = await kernel.executeTurn({ sessionId: 'auto-workflow', prompt: 'Create AGENTS.md with project instructions to run tests before delivery.', model: 'conversation-model', providerType: 'fixture' })
  assert.equal(result.error, null)
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), '# Project\nRun tests before delivery.\n')
  assert.equal(prompts, 0); assert.equal(reviews, 1); assert.equal(normal, 2)
  assert.equal(result.tokenMeter.turn.input, 9); assert.equal(result.tokenMeter.turn.output, 5)
  const stored = await kernel.sessions.getSession('auto-workflow')
  const review = stored.parts.find(part => part.type === 'permission-review')
  assert.equal(review.decision, 'allow'); assert.equal(review.model, 'conversation-model')
  assert.ok(stored.messages.some(message => message.id === review.messageId))
})
