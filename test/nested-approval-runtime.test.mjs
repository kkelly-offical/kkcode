import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { currentRuntime } from '../src/kernel/core/runtime-context.mjs'

test('real delegated write and question retain child identity and durable parent ancestry', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-nested-prompts-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(directory, 'state')
  const prompts = [], calls = new Map()
  const kernel = await createKernel({ cwd: directory, boot: false, trust: true, handlers: {
    onPermissionPrompt(request) { prompts.push({ kind: 'permission', ...request }); return 'allow_once' },
    onQuestionPrompt(request) { prompts.push({ kind: 'question', ...request }); return { choice: 'continue' } }
  } })
  try {
    const config = kernel.configState.config
    config.provider.default = 'fixture'
    config.provider.fixture = { default_model: 'fixture', stream: false, retry_attempts: 0 }
    config.skills.auto_seed = false; config.mcp.auto_discover = false
    config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
    config.permission.level = 'manual'; config.permission.rules = []
    config.agent.verify_completion = false
    config.agent.subagents = { 'tdd-guide': { permission: 'full', tools: ['write', 'question'] } }
    kernel.providers.registerProvider('fixture', { async request() {
      const id = currentRuntime().sessionId, count = (calls.get(id) || 0) + 1
      calls.set(id, count)
      if (id === 'parent' && count === 1) return { text: '', usage: {}, toolCalls: [{ id: 'delegate', name: 'task', args: { prompt: 'Perform the fixture write and ask one question.', subagent_type: 'tdd-guide', allow_question: true } }] }
      if (id !== 'parent' && count === 1) return { text: '', usage: {}, toolCalls: [
        { id: 'write', name: 'write', args: { path: path.join(directory, 'approved.txt'), content: 'approved child write' } },
        { id: 'question', name: 'question', args: { questions: [{ id: 'choice', text: 'Continue?', options: [{ label: 'Continue', value: 'continue' }] }] } }
      ] }
      return { text: 'done', toolCalls: [], usage: {} }
    }, async *requestStream() { yield { type: 'text', content: 'unexpected stream' } } })
    const result = await kernel.executeTurn({ sessionId: 'parent', prompt: 'Delegate the fixture check.', model: 'fixture', providerType: 'fixture', mode: 'assistant' })
    assert.equal(result.reply, 'done')
    const question = prompts.find(request => request.kind === 'question')
    assert.ok(question, `expected a child question, got ${prompts.map(p => p.kind + ':' + p.tool).join(',')}`)
    assert.notEqual(question.sessionId, 'parent')
    assert.equal(question.parentSessionId, 'parent'); assert.equal(question.subagent, 'tdd-guide')
    assert.ok(prompts.some(request => request.tool === 'write' && request.sessionId === question.sessionId && request.parentSessionId === 'parent'))
    assert.equal((await kernel.sessions.getSession(question.sessionId)).session.parentSessionId, 'parent')
    assert.equal((await kernel.sessions.listSessions({ cwd: directory, includeChildren: false })).some(session => session.id === question.sessionId), false)
    assert.equal(await readFile(path.join(directory, 'approved.txt'), 'utf8'), 'approved child write')
  } finally {
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
})
