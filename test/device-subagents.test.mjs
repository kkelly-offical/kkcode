import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { DeviceService } from '../src/device/service.mjs'
import { touchSession, flushNow } from '../src/kernel/session/store.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createTaskDelegate } from '../src/kernel/orchestration/task-scheduler.mjs'
import { updateChildOperation } from '../src/kernel/orchestration/child-state.mjs'

test('live child RPC is scoped, shows model/progress, and owner interruption prevents automatic restart in the same turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-device-children-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const service = await new DeviceService({ cwd: root, roots: [root] }).initialize()
  await service.bindOwner('owner')
  const principal = { id: 'owner', actorId: 'owner', client: 'browser' }, shared = { id: 'owner', actorId: 'viewer', client: 'viewer' }
  const request = (method, params, actor = principal) => service.request({ id: randomUUID(), method, params }, actor)
  await touchSession({ sessionId: 'parent', cwd: root }); await touchSession({ sessionId: 'foreign', cwd: root })
  let entered, child, run
  const started = new Promise(resolve => { entered = resolve }), startedAt = Date.now()
  const delegate = createTaskDelegate({ config: {}, parentSessionId: 'parent', parentTurnStartedAt: startedAt,
    model: 'child-model', providerType: 'fixture', runSubtask: async input => {
      child = input
      await updateChildOperation(input.sessionId, input.childOperationId, { childRuntime: { model: 'child-model', provider: 'fixture', thinking: '深思', output_reserved: 65536, context_limit: 1048576, api_key: 'do-not-expose' }, childProgress: { phase: 'tool', tool: 'read', step: 3 } })
      entered()
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))
      return { status: 'cancelled', cancelled: true, reply: 'Retained partial output, not public snapshot data.' }
    } })
  t.after(async () => { if(child) await request('control.acquire', { sessionId: 'parent' }).then(() => request('subagents.interrupt', { sessionId: 'parent', childSessionId: child.sessionId })).catch(() => {}); await run; await service.close(); await flushNow(); if(previous === undefined)delete process.env.KKCODE_HOME;else process.env.KKCODE_HOME=previous; await rm(root,{recursive:true,force:true}) })
  run = runWithRuntime({ cwd: root }, () => delegate({ prompt: 'private task instructions', description: 'Review configuration', subagent_type: 'explore' }))
  await started
  const snapshot = await request('subagents.list', { sessionId: 'parent' }, shared)
  assert.equal(snapshot.items.length, 1)
  const item = snapshot.items[0]
  assert.equal(item.model, 'child-model'); assert.equal(item.runtime.thinking, '深思')
  assert.equal(item.activity.tool, 'read'); assert.equal(item.activity.step, 3)
  assert.equal(item.description, 'Review configuration')
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-expose|private task instructions|childContract|baseUrl|api_key|reply/)
  assert.deepEqual((await request('subagents.list', { sessionId: 'foreign' })).items, [])
  const lean = await request('sessions.get', { sessionId: 'parent', view: 'subagents' })
  assert.deepEqual(lean.subagents, snapshot.items); assert.equal(lean.messages, undefined)
  await assert.rejects(request('subagents.list', { sessionId: 'parent', accountId: 'other' }), { code: 'subagent_invalid' })
  await assert.rejects(request('subagents.interrupt', { sessionId: 'parent', childSessionId: child.sessionId }, shared), { code: 'forbidden' })
  await assert.rejects(request('subagents.interrupt', { sessionId: 'parent', childSessionId: child.sessionId }), { code: 'control_required' })
  await request('control.acquire', { sessionId: 'foreign' })
  await assert.rejects(request('subagents.interrupt', { sessionId: 'foreign', childSessionId: child.sessionId }), /not owned/)
  await request('control.acquire', { sessionId: 'parent' })
  await request('subagents.interrupt', { sessionId: 'parent', childSessionId: child.sessionId })
  assert.equal((await run).status, 'cancelled')
  const ended = (await request('subagents.list', { sessionId: 'parent' })).items[0]
  assert.equal(ended.status, 'cancelled'); assert.ok(ended.revision > item.revision)
  const followup = await runWithRuntime({ cwd: root }, () => delegate({ session_id: child.sessionId, prompt: 'automatically retry' }))
  assert.equal(followup.status, 'blocked'); assert.match(followup.error, /user stopped/)
})
