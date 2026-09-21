import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createPermissionPromptChannel } from '../src/kernel/permission/prompt.mjs'
import { createQuestionPromptChannel } from '../src/kernel/tool/question-prompt.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createTaskDelegate } from '../src/kernel/orchestration/task-scheduler.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { bindBackgroundPromptWorker, createBackgroundPromptClient, hasBackgroundPromptOwner, registerBackgroundPromptOwner, releaseBackgroundPromptOwner } from '../src/kernel/orchestration/background-prompts.mjs'

function owner(onPermissionPrompt, onQuestionPrompt) {
  const permissionPrompt = createPermissionPromptChannel(), questionPrompt = createQuestionPromptChannel(), host = new AbortController(), turn = new AbortController()
  permissionPrompt.setPermissionPromptHandler(onPermissionPrompt)
  questionPrompt.setQuestionPromptHandler(onQuestionPrompt)
  return { runtime: { permissionPrompt, questionPrompt, hostSignal: host.signal, signal: turn.signal }, host, turn }
}
const task = id => ({ id, payload: { subSessionId: `child_${id}`, parentSessionId: `parent_${id}`, subagent: 'reviewer', allowQuestion: true } })
const clientModule = new URL('../src/kernel/orchestration/background-prompts.mjs', import.meta.url).href

async function worker(spec, runtime, code) {
  assert.equal(registerBackgroundPromptOwner(spec.id, runtime), true)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createBackgroundPromptClient } from ${JSON.stringify(clientModule)}; const client = createBackgroundPromptClient(process, {timeoutMs:2000}); ${code}; client.close(); process.disconnect();`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const cleanup = bindBackgroundPromptWorker(child, spec)
  const exit = once(child, 'exit')
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`worker response timeout: ${stderr}`)), 4000)
    child.on('message', message => { if (message?.type === 'result') { clearTimeout(timeout); resolve(message.value) } })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  try {
    const value = await result, [code] = await exit
    assert.equal(code, 0, stderr)
    return value
  } finally { cleanup(); if (child.exitCode === null) child.kill() }
}

test('real spawned worker prompts use its originating kernel and fixed parent/session authority', { timeout: 10000 }, async () => {
  const seen = []
  const one = owner(request => { seen.push(request); return 'allow_once' }, request => { seen.push(request); return { choice: 'continue' } })
  const two = owner(() => { throw new Error('wrong kernel') }, () => { throw new Error('wrong kernel') })
  registerBackgroundPromptOwner('unrelated', two.runtime)
  try {
    const result = await worker(task('one'), one.runtime, `const permission = await client.onPermissionPrompt({sessionId:'unrelated',parentSessionId:'secret',tool:'write',args:{path:'fixture'}}); const question = await client.onQuestionPrompt({sessionId:'secret',questions:[{id:'choice',text:'Continue?'}]}); process.send({type:'result',value:{permission,question}})`)
    assert.deepEqual(result, { permission: 'allow_once', question: { choice: 'continue' } })
    assert.equal(seen.length, 2)
    for (const request of seen) assert.deepEqual([request.sessionId, request.parentSessionId, request.subagent], ['child_one', 'parent_one', 'reviewer'])
    assert.equal(hasBackgroundPromptOwner('one'), false)
    assert.equal(hasBackgroundPromptOwner('unrelated'), true)
  } finally { releaseBackgroundPromptOwner('unrelated') }
})

test('parent kernel shutdown cancels an outstanding worker prompt and returns deny', { timeout: 10000 }, async () => {
  let localSignal
  const origin = owner(request => { localSignal = request.signal; queueMicrotask(() => origin.host.abort()); return new Promise(() => {}) }, null)
  const result = await worker(task('shutdown'), origin.runtime, `const answer = await client.onPermissionPrompt({tool:'write'}); process.send({type:'result',value:answer})`)
  assert.equal(result, 'deny'); assert.equal(localSignal.aborted, true); assert.equal(hasBackgroundPromptOwner('shutdown'), false)
})

test('parent turn cancellation settles worker questions with an empty answer', { timeout: 10000 }, async () => {
  const origin = owner(null, () => { queueMicrotask(() => origin.turn.abort()); return new Promise(() => {}) })
  const result = await worker(task('cancel'), origin.runtime, `const answer = await client.onQuestionPrompt({questions:[{id:'choice',text:'Continue?'}]}); process.send({type:'result',value:answer})`)
  assert.deepEqual(result, {})
})

test('a worker cannot enable questions when the task did not allow them', { timeout: 10000 }, async () => {
  const origin = owner(() => 'deny', () => { throw new Error('must not be called') }), spec = task('readonly')
  spec.payload.allowQuestion = false
  const result = await worker(spec, origin.runtime, `const answer = await client.onQuestionPrompt({questions:[{id:'choice',text:'Continue?'}]}); process.send({type:'result',value:answer})`)
  assert.deepEqual(result, {})
})

test('worker-side disconnect, cancellation and duplicate replies settle once without consent', async () => {
  const peer = new EventEmitter(), sent = [], controller = new AbortController()
  peer.connected = true; peer.send = (message, done) => { sent.push(message); done?.() }
  const client = createBackgroundPromptClient(peer, { signal: controller.signal })
  const pending = client.onPermissionPrompt({ tool: 'write' })
  controller.abort(); assert.equal(await pending, 'deny')
  assert.equal(sent.at(-1).type, 'kkcode.prompt.cancel')
  peer.emit('message', { type: 'kkcode.prompt.response', id: sent[0].id, answer: 'allow_once' })
  client.close(); assert.equal(peer.listenerCount('message'), 0)
  const second = createBackgroundPromptClient(peer), question = second.onQuestionPrompt({ questions: [{ id: 'a', text: 'A?' }] })
  peer.connected = false; peer.emit('disconnect'); assert.deepEqual(await question, {})
  second.close()
})

test('headless or closed kernels cannot register a background prompt capability', () => {
  const headless = owner(null, null)
  assert.equal(registerBackgroundPromptOwner('none', headless.runtime), false)
  headless.runtime.permissionPrompt.setPermissionPromptHandler(() => 'allow_once'); headless.host.abort()
  assert.equal(registerBackgroundPromptOwner('none', headless.runtime), false)
})

test('a live interactive parent may explicitly permit background questions', async () => {
  const origin = owner(() => 'deny', () => ({})), original = BackgroundManager.launchDelegateTask
  let launched
  BackgroundManager.launchDelegateTask = async input => { launched = input; return { id: 'task_fixture', status: 'pending' } }
  try {
    await runWithRuntime(origin.runtime, async () => {
      const delegate = createTaskDelegate({ config: {}, parentSessionId: 'parent', model: 'fixture', providerType: 'fixture', runSubtask: async () => { throw new Error('unexpected inline execution') } })
      assert.equal((await delegate({ prompt: 'Ask if needed', run_in_background: true, allow_question: true })).background_task_id, 'task_fixture')
    })
    assert.equal(launched.payload.allowQuestion, true)
  } finally { BackgroundManager.launchDelegateTask = original }
})
