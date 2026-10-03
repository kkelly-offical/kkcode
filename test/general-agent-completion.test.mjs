import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/kernel.mjs'
import { priorCompletionEvidence } from '../src/kernel/session/completion-history.mjs'
import { appendMessage } from '../src/kernel/session/store.mjs'
import { completionInputHistory } from '../src/kernel/session/completion-policy.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-general-agent-')), cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  const kernel = await createKernel({cwd, trustState: {trusted: true}, config: {config: {
    provider: {default: 'general-fixture', 'general-fixture': {default_model: 'fixture', retry_attempts: 0}},
    agent: {max_steps: 8}, permission: {level: 'yolo', rules: []},
    tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}},
    session: {title_generation: false, recovery: false}, usage: {budget: {}}, ui: {markdown_render: false}, language: 'zh'
  }}})
  t.after(async () => { await kernel.shutdown(); if(previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, {recursive: true, force: true}) })
  return {kernel, cwd}
}

for (const [name, call, prompt] of [
  ['ops', {name: 'bash', args: {command: 'node -p "process.platform"'}}, '查看这台电脑的系统类型。'],
  ['document', {name: 'write', args: {path: 'notes.md', content: '# Meeting notes\nReview the agenda.\n'}}, '整理并保存会议笔记。'],
  ['failed-check', {name: 'bash', args: {command: 'node --test missing.test.mjs'}}, '运行这个现有检查并报告结果，不要修复。']
]) test(`default general agent ends ${name} work without inventing a test task`, async t => {
  const {kernel, cwd} = await fixture(t)
  let requests = 0, stage = 'work'
  const events = []
  const detach = kernel.events.subscribe(event => events.push(event))
  t.after(detach)
  kernel.providers.registerProvider('general-fixture', {
    async request() { assert.fail('stream fixture only') },
    async *requestStream(input) {
      requests++
      assert.doesNotMatch(JSON.stringify(input.messages), /TASK VERIFICATION FAILED|任务验证失败|VERIFICATION FEEDBACK|检查反馈/)
      if(stage === 'work' && requests === 1) yield {type: 'tool_call', call: {id: 'requested-operation', ...call}}
      else yield {type: 'text', content: name === 'failed-check' && stage === 'work' ? '检查失败：指定的测试文件不存在。按要求未做修复。' : stage === 'work' ? '已完成你要求的操作。' : '当前没有新的工作安排。'}
      yield {type: 'usage', usage: {input: 900, output: 70, cacheRead: 100, cacheWrite: 0}}
    }
  })
  const execute = prompt => kernel.executeTurn({prompt, sessionId: `general-${name}`, mode: 'assistant', model: 'fixture', providerType: 'general-fixture'})
  const result = await execute(prompt)
  assert.equal(requests, 2)
  assert.equal(result.status, 'completed')
  assert.equal(result.verification.required, false)
  assert.equal(result.verification.passed, false, 'an ended answer must not invent a passing acceptance receipt')
  assert.equal(result.verification.verdict, 'OBSERVATIONS_RECORDED')
  const first = await kernel.sessions.getSession(result.sessionId)
  assert.equal(first.parts.findLast(part => part.type === 'turn-outcome').completionPolicy, 'observational')
  assert.ok((await priorCompletionEvidence(first, {requireVerification: true})).toolEvents.length > 0, 'strict callers still recover unverified evidence')
  assert.equal((await priorCompletionEvidence(first, {requireVerification: false})).toolEvents.length, 0)
  const usages = events.filter(event => event.type === 'turn.usage.update' && event.payload.context)
  assert.ok(usages.length)
  for(const event of usages) {
    assert.equal(event.payload.context.tokens, 1000)
    assert.equal(event.payload.context.source, 'provider-usage')
    const next = events.slice(events.indexOf(event) + 1).find(item => item.type === 'session.context.updated')
    assert.deepEqual(next.payload.context, event.payload.context)
  }
  await appendMessage(result.sessionId, 'user', '[TASK VERIFICATION FAILED] Old host test repair instruction', {synthetic: true, contextKind: 'control', turnId: result.turnId})
  stage = 'status'; const count = requests
  assert.equal((await execute('你现在有啥工作吗？')).status, 'completed')
  assert.equal(requests, count + 1)
  assert.equal((await readdir(cwd)).some(file => /\.test\./.test(file)), false)
  assert.ok((await kernel.sessions.getSession(result.sessionId)).messages.some(message => String(message.content).includes('Old host test repair instruction')), 'filtering the model input never deletes canonical evidence')
})

test('optional policy removes only provenance-tagged host repair instructions, never user text or safety notices', () => {
  const host = {role: 'user', synthetic: true, contextKind: 'control', content: '[TASK VERIFICATION FAILED] repair'}
  const pasted = {...host, synthetic: false}, unknown = {...host, content: '[NO PROGRESS] inspect before retrying'}
  assert.deepEqual(completionInputHistory([host, pasted, unknown], false), [pasted, unknown])
  assert.deepEqual(completionInputHistory([host, pasted, unknown], true), [host, pasted, unknown])
})
