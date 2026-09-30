import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTaskDelegate, createChildController } from '../src/kernel/orchestration/task-scheduler.mjs'
import { createRunSpec } from '../src/kernel/orchestration/run-spec.mjs'
import { childOutcome, isReadOnlyWriteScope } from '../src/kernel/orchestration/child-policy.mjs'
import { resolveSubagent } from '../src/kernel/orchestration/subagent-router.mjs'
import { createChildControlTools, formatTaskResult } from '../src/kernel/tool/task-tool.mjs'
import { flushNow, touchSession, getSession } from '../src/kernel/session/store.mjs'

let temporaryHome, previousHome
before(async () => { previousHome = process.env.KKCODE_HOME; temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'kkcode-child-control-')); process.env.KKCODE_HOME = temporaryHome })
after(async () => { await flushNow(); if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome; await rm(temporaryHome, { recursive: true, force: true }) })
const make = (overrides = {}) => createTaskDelegate({ config: {}, parentSessionId: 'owner', model: 'original-model', providerType: 'fixture', runSubtask: async () => ({ reply: 'done', toolEvents: [] }), ...overrides })

test('unknown explicit roles fail closed with empty config and registry defaults/categories retain ceilings', async () => {
  assert.match((await make()({ prompt: 'test', subagent_type: 'invented-agent' })).error, /unknown subagent_type/)
  for (const args of [{}, { category: 'audit' }]) {
    const role = resolveSubagent({ config: { agent: { subagents: { explore: { model: 'fixture-model' } }, routing: { categories: { audit: 'explore' } } } }, ...args })
    assert.equal(role.permission, 'readonly')
    assert.ok(role.tools.includes('read'))
  }
})

test('owned continuation after controller recreation retains model, role, read-only and zero budget', async () => {
  const first = await make({ config: { permission: { level: 'yolo' } } })({ prompt: 'read only', subagent_type: 'explore', write_scope: 'no writes', budget_usd: 0 })
  assert.equal(first.status, 'completed')
  let input
  const resumed = make({ config: { permission: { level: 'yolo' }, agent: { subagents: { unsafe: { permission: 'yolo', tools: ['bash'] } } } }, model: 'new-model', runSubtask: async value => { input = value; return { reply: 'continued', toolEvents: [] } } })
  assert.equal((await resumed({ session_id: first.session_id, prompt: 'continue' })).status, 'completed')
  assert.equal(input.model, 'original-model')
  assert.equal(input.runSpec.role.name, 'explore')
  assert.equal(input.runSpec.role.permission, 'readonly')
  assert.equal(input.runSpec.workspace.writeScope, 'read-only')
  assert.equal(input.runSpec.limits.budgetUsd, 0)
  assert.ok(input.runSpec.role.tools.includes('read'))
  assert.match((await resumed({ session_id: first.session_id, prompt: 'continue', subagent_type: 'unsafe' })).error, /retains its original/)
})

test('foreign, ordinary and missing sessions cannot be adopted by continuation', async () => {
  const owned = await make()({ prompt: 'start' })
  await touchSession({ sessionId: 'ordinary', mode: 'agent', model: 'fixture', providerType: 'fixture', cwd: process.cwd() })
  let calls = 0
  const attacker = make({ parentSessionId: 'foreign', runSubtask: async () => { calls++; return {} } })
  for (const id of [owned.session_id, 'ordinary', 'missing', 'foreign']) assert.match((await attacker({ session_id: id, prompt: 'continue' })).error, /not owned/)
  assert.equal(calls, 0)
  assert.equal((await getSession(owned.session_id)).session.parentSessionId, 'owner')
})

test('children intersect parent tool and permission ceilings and preserve restrictive scope', async () => {
  let input
  await make({ config: { permission: { level: 'yolo' }, agent: { subagents: { helper: { tools: ['bash', 'read', 'write'], permission: 'yolo' } } } },
    parentAgent: { tools: ['task', 'read'], permission: 'readonly' }, parentRunSpec: createRunSpec({ role: { tools: ['read'], permission: 'readonly' }, workspace: { writeScope: 'no mutations' }, limits: { budgetUsd: 0, deadlineAt: 500 } }),
    runSubtask: async value => { input = value; return { reply: 'done' } }
  })({ prompt: 'test', subagent_type: 'helper', budget_usd: 10, deadline_at: 1000 })
  assert.deepEqual(input.runSpec.role.tools, ['read'])
  assert.equal(input.runSpec.role.permission, 'readonly')
  assert.equal(input.runSpec.workspace.writeScope, 'read-only')
  assert.deepEqual(input.runSpec.limits, { budgetUsd: 0, deadlineAt: 500 })
})

test('structured engine failures, cancellation, uncertainty and exhaustion are never formatted as success', async () => {
  for (const out of [{ error: 'quota', reply: '[TASK_COMPLETE]' }, { cancelled: true, reply: 'partial', partialReply: 'kept' }, { status: 'unknown', reply: 'maybe done' }, { stopReason: 'no-progress', reply: 'stuck' }, { stopReason: 'max-steps', reply: 'partial' }]) {
    const result = await make({ runSubtask: async () => out })({ prompt: 'start' })
    assert.notEqual(result.status, 'completed')
    assert.deepEqual(formatTaskResult(result), result)
  }
  assert.equal(childOutcome({ status: 'invented' }).status, 'unknown')
})

test('single-session guard, bounded messaging, wait timeout, interruption, followup all work', async () => {
  let running, resume
  const started = new Promise(resolve => { running = resolve })
  const pause = new Promise(resolve => { resume = resolve })
  let received, turns = 0
  const delegateTask = make({ runSubtask: async input => {
    turns++
    if (turns === 1) {
      running(input)
      await pause
      received = await input.steerSource()
      await new Promise(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener('abort', resolve, { once: true }))
      return { reply: 'partial effect', partialReply: 'partial effect', cancelled: true }
    }
    return { reply: 'explicit followup', toolEvents: [] }
  } })
  const resultPromise = delegateTask({ prompt: 'start' })
  const input = await started
  const controller = createChildController({ parentSessionId: 'owner', delegateTask })
  assert.match((await delegateTask({ session_id: input.sessionId, prompt: 'racing' })).error, /live|running/)
  assert.equal((await controller.wait(input.sessionId, { timeoutMs: 0 })).timed_out, true)
  assert.equal((await controller.send(input.sessionId, 'inspect before continuing')).status, 'queued')
  await assert.rejects(controller.send(input.sessionId, 'a'.repeat(16001)), /characters/)
  resume()
  await controller.interrupt(input.sessionId)
  assert.equal((await resultPromise).status, 'cancelled')
  assert.deepEqual(received, ['inspect before continuing'])
  assert.equal((await controller.get(input.sessionId)).status, 'cancelled')
  assert.equal((await controller.followup(input.sessionId, 'inspect previous effects')).status, 'completed')
  assert.equal(turns, 2)
  assert.equal((await controller.wait(input.sessionId)).timed_out, false)
  const foreign = createChildController({ parentSessionId: 'other', delegateTask })
  await assert.rejects(foreign.interrupt(input.sessionId), /not owned/)
  assert.deepEqual(await foreign.list(), [])
})

test('all read-only spelling aliases canonicalize identically and control tools dispatch real API', async () => {
  for (const scope of ['read-only', 'readonly', 'read_only', 'no write', 'no-writes', 'no mutations', 'read-only sidecar', 'none']) assert.equal(isReadOnlyWriteScope(scope), true, scope)
  assert.equal(isReadOnlyWriteScope('write src/a.mjs'), false)
  const list = createChildControlTools().find(tool => tool.name === 'agent_list')
  assert.deepEqual(await list.execute({}, { childController: { list: async () => ['owned'] } }), ['owned'])
})

test('cross-process continuation uses persisted ceilings and atomic session operation claim', async () => {
  const initial = await make({ config: { permission: { level: 'readonly', rules: [{ tool: 'bash', action: 'deny' }] } }, getSkillToolGroups: () => [['read']] })({ prompt: 'start', subagent_type: 'explore', write_scope: 'no-write' })
  const program = `import {createTaskDelegate} from './src/kernel/orchestration/task-scheduler.mjs';
    const run=createTaskDelegate({config:{permission:{level:'yolo'}},parentSessionId:'owner',model:'unsafe-model',providerType:'fixture',runSubtask:async input=>{
      await new Promise(resolve=>setTimeout(resolve,200));return {reply:JSON.stringify({model:input.model,role:input.runSpec.role,scope:input.runSpec.workspace.writeScope,groups:input.runSpec.toolContext.skillToolGroups,ceilings:input.runSpec.toolContext.permissionCeilings})};}});
    console.log(JSON.stringify(await run({session_id:${JSON.stringify(initial.session_id)},prompt:'explicit followup'})));`
  const results = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { cwd: process.cwd(), env: process.env, timeout: 10000 }).then(({ stdout }) => JSON.parse(stdout))))
  assert.equal(results.filter(result => result.status === 'completed').length, 1)
  assert.equal(results.filter(result => /live|running|changed/.test(result.error || '')).length, 1)
  const inherited = JSON.parse(results.find(result => result.status === 'completed').reply)
  assert.equal(inherited.model, 'original-model')
  assert.equal(inherited.role.permission, 'readonly')
  assert.equal(inherited.scope, 'read-only')
  assert.deepEqual(inherited.groups, [['read']])
  assert.ok(inherited.ceilings.some(policy => policy.rules?.some(rule => rule.tool === 'bash' && rule.action === 'deny')))
})

test('undelivered messages are not silently replayed into a later child operation', async () => {
  let started, finish
  const active = new Promise(resolve => { started = resolve })
  const pause = new Promise(resolve => { finish = resolve })
  let turns = 0, laterMessages
  const delegateTask = make({ runSubtask: async input => {
    if (++turns === 1) { started(input.sessionId); await pause }
    else laterMessages = await input.steerSource()
    return { reply: 'done' }
  } })
  const pending = delegateTask({ prompt: 'start' }), sessionId = await active
  const controller = createChildController({ parentSessionId: 'owner', delegateTask })
  for (let i = 0; i < 32; i++) await controller.send(sessionId, `bounded message ${i}`)
  await assert.rejects(controller.send(sessionId, 'overflow'), /mailbox is full/)
  finish(); await pending
  await controller.followup(sessionId, 'new explicit turn')
  assert.deepEqual(laterMessages, [])
  assert.equal((await getSession(sessionId)).session.childUndeliveredMessages.length, 32)
})

test('background boundaries and continuation cannot reset inherited delegation depth', async () => {
  let received
  const delegate = make({ parentDepth: 7, runSubtask: async input => { received = input; return { reply: 'done' } } })
  const first = await delegate({ prompt: 'last allowed depth' })
  assert.equal(received.runSpec.toolContext.childDepth, 8)
  const nested = make({ parentRunSpec: received.runSpec, runSubtask: async () => { throw new Error('must not run') } })
  assert.equal((await nested({ prompt: 'too deep', run_in_background: true })).status, 'blocked')
  await make({ parentDepth: 0, runSubtask: async input => { received = input; return { reply: 'resumed' } } })({ session_id: first.session_id, prompt: 'same depth after restart' })
  assert.equal(received.runSpec.toolContext.childDepth, 8)
})

test('mode and workspace qualified parent rules become immutable child ceilings without freezing caller config', async () => {
  let spec
  const permission = { level: 'yolo', rules: [
    { tool: 'write', action: 'deny', modes: ['plan'], workspace: process.cwd(), file_patterns: ['src/**'] },
    { tool: 'read', action: 'allow', modes: ['agent'], workspace: process.cwd() }
  ] }
  await make({ parentMode: 'plan', parentPermissionConfig: { permission }, runSubtask: async input => { spec = input.runSpec; return { reply: 'done' } } })({ prompt: 'bounded review' })
  const captured = spec.toolContext.permissionCeilings[0]
  assert.deepEqual(captured.rules, [{ tool: 'write', action: 'deny', file_patterns: ['src/**'] }])
  assert.equal(Object.isFrozen(permission.rules[0].file_patterns), false)
  permission.rules[0].file_patterns.push('other/**')
  assert.deepEqual(captured.rules[0].file_patterns, ['src/**'])
})

test('legacy finite-budget continuation fails closed instead of resetting its spend counter', async () => {
  let calls = 0
  const delegate = make({ runSubtask: async () => { calls++; return { reply: 'partial', cost: 0.1 } } })
  const first = await delegate({ prompt: 'bounded initial turn', budget_usd: 1 })
  assert.equal(first.status, 'completed')
  const resumed = await delegate({ session_id: first.session_id, prompt: 'continue with same budget' })
  assert.equal(resumed.status, 'blocked')
  assert.match(resumed.error, /cumulative host reservation ledger/)
  assert.equal(calls, 1)
})
