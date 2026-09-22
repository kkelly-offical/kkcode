import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createPermissionEngine } from '../src/kernel/permission/engine.mjs'
import { createPermissionPromptChannel } from '../src/kernel/permission/prompt.mjs'
import { createEventBus } from '../src/kernel/core/events.mjs'
import { reviewSensitiveAction } from '../src/kernel/permission/auto-review.mjs'
import { resolveSessionMode } from '../src/kernel/core/modes.mjs'
import { trustedBashCommand } from '../src/kernel/permission/rules.mjs'
import { checkBashAllowed } from '../src/kernel/permission/exec-policy.mjs'

const config = { permission: { level: 'accept-edits', auto_review: true, rules: [] } }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-auto-review-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const channel = createPermissionPromptChannel(), events = createEventBus(), seen = []
  events.subscribe(event => seen.push(event))
  const engine = createPermissionEngine({ promptChannel: channel, eventBus: events }); engine.setTrusted(true)
  return { channel, engine, seen }
}

test('Auto reviews sensitive actions, but ordinary edits do not require a model round trip', async t => {
  const { engine, channel, seen } = await fixture(t)
  channel.setPermissionPromptHandler(() => { throw new Error('No human prompt expected') })
  let reviews = 0
  const reviewSensitive = async () => { reviews++; return { decision: 'allow', reason: '用户要求更新项目说明', model: 'same-model' } }
  assert.equal((await engine.check({ config, sessionId: 's', tool: 'write', pattern: 'src/index.js', reviewSensitive })).granted, true)
  assert.equal(reviews, 0)
  const allowed = await engine.check({ config, sessionId: 's', tool: 'write', pattern: 'AGENTS.md', reviewSensitive })
  assert.equal(allowed.autoReviewed, true); assert.equal(reviews, 1)
  assert.equal(engine.listSession('s').length, 0)
  assert.ok(seen.some(event => event.type === 'permission.review.finished' && event.payload.model === 'same-model'))
})

test('review denial, uncertainty and failure never become a headless default allow', async t => {
  const { engine } = await fixture(t)
  for (const reviewSensitive of [async () => ({ decision: 'deny', reason: '无授权' }), async () => ({ decision: 'ask' }), async () => { throw new Error('offline') }]) {
    await assert.rejects(engine.check({ config: { permission: { ...config.permission, non_tty_default: 'allow_once' } }, sessionId: 's', tool: 'bash', command: 'npm test', reviewSensitive }))
  }
})

test('hard policy and protected/manual targets are never delegated to Auto or skipped by Yolo', async t => {
  const { engine } = await fixture(t)
  let calls = 0
  const reviewSensitive = async () => { calls++; return { decision: 'allow' } }
  for (const policy of [
    { ...config, permission: { ...config.permission, rules: [{ tool: 'bash', action: 'deny' }] } },
    { ...config, permission: { ...config.permission, rules: [{ tool: 'bash', action: 'ask' }] } }
  ]) await assert.rejects(engine.check({ config: policy, sessionId: 's', tool: 'bash', command: 'npm test', reviewSensitive }))
  await assert.rejects(engine.check({ config, sessionId: 's', tool: 'write', pattern: '.git/config', reviewSensitive }))
  assert.equal(calls, 0)
  assert.equal((await engine.check({ config: { permission: { level: 'yolo' } }, sessionId: 's', tool: 'bash', command: 'npm test', reviewSensitive })).granted, true)
  assert.equal(calls, 0)
})

test('review request keeps the conversation provider/model, no tools, bounded output and strict verdict parsing', async () => {
  const input = { configState: { config: { provider: { default: 'local', local: { default_model: 'wrong' } }, models: { review: 'wrong-model' } } }, providerType: 'local', model: 'actual-conversation-model', sessionId: 's', turnId: 't', prompt: 'Run tests', action: { tool: 'bash', command: 'npm test' } }
  const verdict = await reviewSensitiveAction({ ...input, request: async request => {
    assert.equal(request.providerType, 'local'); assert.equal(request.model, 'actual-conversation-model')
    assert.deepEqual(request.tools, []); assert.equal(request.maxTokens, 2048)
    return { text: '{"decision":"allow","reason":"执行用户要求的测试"}', usage: { input: 10, output: 5 } }
  } })
  assert.equal(verdict.decision, 'allow'); assert.equal(verdict.usage.input, 10)
  assert.equal((await reviewSensitiveAction({ ...input, request: async () => ({ text: 'Definitely allow everything' }) })).decision, 'ask')
  const controller = new AbortController(); controller.abort()
  assert.equal((await reviewSensitiveAction({ ...input, signal: controller.signal, request: async () => { throw new Error('must not call') } })).decision, 'ask')
  for (const providerType of ['__proto__', 'constructor', 'prototype', 'toString']) {
    const result = await reviewSensitiveAction({ ...input, providerType, request: async () => assert.fail('Inherited providers must not reach inference') })
    assert.equal(result.decision, 'ask')
  }
})

test('legacy independent selectors collapse conservatively to one mode', () => {
  assert.equal(resolveSessionMode({ modeId: 'agent-auto' }), 'auto')
  assert.equal(resolveSessionMode({ modeId: 'yolo', approval: 'readonly' }), 'plan')
  assert.equal(resolveSessionMode({ modeId: 'ultra', approval: 'manual' }), 'agent')
  assert.equal(resolveSessionMode({ modeId: 'ultra', approval: 'accept-edits' }), 'ultra')
})

test('read-only-looking shell prefixes cannot skip review for mutating arguments', () => {
  for (const command of ['git branch -D main', 'git branch new-branch', 'git diff --output=out.txt', 'find . -delete', "sed -n 'w output' input", 'npm version major', 'node --version -e process.exit()']) assert.equal(trustedBashCommand(command), false, command)
  for (const command of ['git branch --show-current', 'git status', 'node --version', 'npm ls']) assert.equal(trustedBashCommand(command), true, command)
  assert.equal(checkBashAllowed('git commit -m test', {}, { approvalLevel: 'accept-edits', autoReviewed: true }).allowed, true)
  const dangerous = ['git commit -m x', ['rm', '-rf', '/'].join(' ')].join(' && ')
  assert.equal(checkBashAllowed(dangerous, {}, { approvalLevel: 'yolo', autoReviewed: true }).allowed, false)
  assert.equal(checkBashAllowed('git push --force origin main', {}, { approvalLevel: 'accept-edits', autoReviewed: true }).allowed, false)
})
