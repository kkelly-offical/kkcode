import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runHybridLongAgent } from '../src/kernel/session/longagent-hybrid.mjs'
import { runStrictUltraStage, strictStageTaskStatus } from '../src/kernel/session/strict-ultra-stage.mjs'
import { createSessionTodoService } from '../src/kernel/session/todo-service.mjs'
import { touchSession, getTodoSnapshot, flushNow } from '../src/kernel/session/store.mjs'
import { EventBus } from '../src/kernel/core/events.mjs'
import { EVENT_TYPES } from '../src/kernel/core/constants.mjs'
import { registerProvider } from '../src/kernel/provider/router.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { saveCheckpoint } from '../src/kernel/session/checkpoint.mjs'
import { validateAndNormalizeStagePlan } from '../src/kernel/session/longagent-plan.mjs'
import { createScriptedProvider, stagePlanFence, ultraConfig } from './helpers/ultra-harness.mjs'
import { installBackgroundMock, restoreBackgroundMock } from './helpers/background-mock.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-ultra-todo-')), cwd = path.join(root, 'project')
  const previousHome = process.env.KKCODE_HOME, previousCwd = process.cwd()
  process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(cwd); process.chdir(cwd)
  t.after(async () => {
    restoreBackgroundMock(); await flushNow(); process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  return { root, cwd, sessionId: 'ultra-todo-session' }
}
function plan() {
  return { planId: 'ultra-task-plan', objective: 'Build two fixture modules', goal: { objective: 'Build modules', criteria: [
    { kind: 'file_exists', text: 'first output exists', spec: { path: 'src/first.mjs' } },
    { kind: 'file_exists', text: 'second output exists', spec: { path: 'src/second.mjs' } }
  ] }, stages: [{ stageId: 'implementation', name: 'Implement modules', tasks: [
    { taskId: 'first', prompt: 'Create first module', plannedFiles: ['src/first.mjs'], acceptance: ['src/first.mjs'], maxRetries: 0 },
    { taskId: 'second', prompt: 'Create second module', dependsOn: ['first'], plannedFiles: ['src/second.mjs'], acceptance: ['src/second.mjs'], maxRetries: 0 }
  ] }] }
}
function config() {
  return ultraConfig({ providerName: 'ultra-todo-fixture', longagent: { max_stage_attempts: 1, recovery_attempts: 0 },
    gates: { smoke: { enabled: false } } }, { ultra: { max_rounds: 1, ledger: { enabled: false }, report: { llm_summary: false }, stage_failure: { max_replans: 0 } } })
}
async function execute(f, options = {}) {
  registerProvider('ultra-todo-fixture', createScriptedProvider([
    ...(options.replanPlan ? [{ match: /重规划原因/, reply: stagePlanFence(options.replanPlan) }] : []),
    { stage: 1, reply: 'Repository inspected.' }, { stage: 2, reply: stagePlanFence(options.plan || plan()) },
    { stage: 4, reply: '[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]' }
  ]))
  installBackgroundMock(options.background || {})
  return runWithRuntime({ cwd: f.cwd }, () => runHybridLongAgent({ prompt: 'Create two fixture modules and verify the requested outputs',
    model: 'fixture', providerType: 'ultra-todo-fixture', sessionId: f.sessionId, configState: options.configState || config(), allowQuestion: false,
    signal: options.signal, deps: options.deps || {} }))
}

test('public Ultra projects actual scheduler transitions with stable IDs and preserves user-owned todos', async t => {
  const f = await fixture(t)
  await touchSession({ sessionId: f.sessionId, cwd: f.cwd, mode: 'longagent', model: 'fixture', providerType: 'ultra-todo-fixture' })
  const userService = await createSessionTodoService({ sessionId: f.sessionId, emit: () => {} })
  const initial = await userService.update({ todos: [{ content: 'User-owned outstanding decision', status: 'pending' }] })
  const snapshots = [], before = EventBus.listenerCount()
  const off = EventBus.subscribe(event => { if (event.type === 'todo.updated' && event.sessionId === f.sessionId) snapshots.push(event.payload.snapshot) })
  let result
  try { result = await execute(f) } finally { off() }
  assert.equal(EventBus.listenerCount(), before)
  assert.equal(result.status, 'completed')
  assert.equal(result.acceptance.mode, 'legacy_unbound')
  assert.equal(result.acceptance.receipt, undefined)
  const saved = await getTodoSnapshot(f.sessionId), own = saved.items.filter(item => item.owner.agentId === 'ultra')
  assert.equal(own.length, 3)
  assert.ok(own.every(item => item.status === 'completed'))
  assert.equal(saved.items.find(item => item.id === initial.items[0].id).status, 'pending')
  for (const item of own.filter(item => item.content.includes('implementation'))) {
    const versions = snapshots.flatMap(snapshot => snapshot.items.filter(candidate => candidate.content === item.content))
    assert.equal(new Set(versions.map(item => item.id)).size, 1)
    assert.ok(versions.some(item => item.status === 'pending'))
    assert.ok(versions.some(item => item.status === 'in_progress'))
  }
  const first = own.find(item => item.content.includes('"first"')), second = own.find(item => item.content.includes('"second"'))
  assert.deepEqual(second.dependencies, [first.id])
  assert.match(own.find(item => !item.content.includes('implementation')).content, /验收结果单独记录/)
  assert.equal(own.some(item => Object.hasOwn(item, 'verified')), false)
  const renamed = plan()
  renamed.stages[0].name = 'Renamed display title, same task identities'
  await execute(f, { plan: renamed })
  assert.deepEqual((await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra').map(item => item.id).sort(), own.map(item => item.id).sort())
})

test('Ultra model completion prose cannot paint failed and skipped scheduler tasks green', async t => {
  const f = await fixture(t)
  const result = await execute(f, { background: { writeFiles: false, behavior: () => ({ error: 'EACCES: fixture cannot perform requested work' }) } })
  assert.notEqual(result.status, 'completed')
  const own = (await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra')
  assert.equal(own.length, 3)
  assert.ok(own.every(item => item.status === 'blocked'), JSON.stringify(own))
  assert.equal(result.acceptance.mode, 'legacy_unbound')
})

test('Ultra abort after plan freeze persists cancelled backlog and releases event observers', async t => {
  const f = await fixture(t), controller = new AbortController(), snapshots = []
  const before = EventBus.listenerCount()
  const off = EventBus.subscribe(event => {
    if (event.sessionId !== f.sessionId) return
    if (event.type === 'todo.updated') snapshots.push(event.payload.snapshot)
    if (event.type === EVENT_TYPES.LONGAGENT_PLAN_FROZEN) controller.abort()
  })
  try {
    const result = await execute(f, { signal: controller.signal })
    assert.equal(result.status, 'user_stopped')
  } catch (error) { assert.equal(error.name, 'AbortError') }
  finally { off() }
  const own = (await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra')
  assert.equal(own.length, 3)
  assert.ok(own.every(item => item.status === 'cancelled'))
  assert.ok(snapshots.some(snapshot => snapshot.items.some(item => item.status === 'pending')))
  assert.equal(EventBus.listenerCount(), before)
})

test('Ultra fatal gate error preserves completed task evidence but blocks the coordinator', async t => {
  const f = await fixture(t), before = EventBus.listenerCount()
  await assert.rejects(execute(f, { deps: { runUsabilityGates: async () => { throw new Error('controlled gate unavailable') } } }), /controlled gate unavailable/)
  const own = (await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra')
  assert.equal(own.find(item => !item.content.includes('implementation')).status, 'blocked')
  assert.ok(own.filter(item => item.content.includes('implementation')).every(item => item.status === 'completed'))
  assert.equal(EventBus.listenerCount(), before)
})

test('strict stage cannot turn incomplete child execution into success with no planned files', async t => {
  const f = await fixture(t), state = config()
  state.config.agent.max_steps = 1
  registerProvider('ultra-todo-fixture', {
    async request() { return { text: '', usage: { input: 1, output: 1 }, toolCalls: [{ id: 'unavailable', name: 'unavailable_fixture_tool', args: {} }] } },
    async *requestStream() { throw new Error('streaming disabled in fixture') }
  })
  let checkpointed = 0
  const result = await runWithRuntime({ cwd: f.cwd }, () => runStrictUltraStage({ stage: { stageId: 'strict', tasks: [{ taskId: 'empty-output', prompt: 'Perform fixture task', plannedFiles: [] }] },
    sessionId: f.sessionId, model: 'fixture', providerType: 'ultra-todo-fixture', configState: state,
    toolContext: {}, objective: 'Perform fixture task', onTaskComplete: () => { checkpointed++ } }))
  assert.equal(result.allSuccess, false)
  assert.equal(result.successCount, 0)
  assert.equal(result.taskProgress['empty-output'].status, 'incomplete')
  assert.equal(result.taskProgress['empty-output'].executionStatus, 'incomplete')
  assert.deepEqual(result.taskProgress['empty-output'].remainingFiles, [])
  assert.equal(checkpointed, 0)
  for (const status of ['incomplete', 'blocked', 'unknown', 'error', 'cancelled', 'interrupted', undefined]) assert.notEqual(strictStageTaskStatus({ status, reply: '[TASK_COMPLETE]' }, []), 'completed')
  assert.equal(strictStageTaskStatus({ status: 'completed', toolEvents: [{ metadata: { outcomeUnknown: true } }] }, []), 'unknown')
  assert.equal(strictStageTaskStatus({ status: 'completed', verification: { passed: false } }, []), 'blocked')
  assert.equal(strictStageTaskStatus({ status: 'completed' }, ['missing.txt']), 'error')
})

test('same task ID in a different Ultra stage cannot reuse or relabel the earlier execution receipt', async t => {
  const f = await fixture(t), definition = plan(), dispatched = []
  definition.stages = [
    { stageId: 'first-stage', name: 'First', tasks: [{ ...definition.stages[0].tasks[0], taskId: 'same' }] },
    { stageId: 'second-stage', name: 'Second', tasks: [{ ...definition.stages[0].tasks[1], taskId: 'same', dependsOn: [] }] }
  ]
  const result = await execute(f, { plan: definition, background: { behavior: payload => { dispatched.push(payload); return null } } })
  assert.equal(result.status, 'completed')
  assert.equal(dispatched.length, 2)
  assert.ok((await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra').every(item => item.status === 'completed'))
})

test('same Ultra task identity with changed semantics blocks old completion without automatically replaying effects', async t => {
  const f = await fixture(t), definition = plan(), dispatched = []
  definition.goal.criteria = [{ kind: 'file_exists', text: 'new output exists', spec: { path: 'src/new.mjs' } }]
  definition.stages[0].tasks = [{ taskId: 'same', prompt: 'Create original output', plannedFiles: ['src/old.mjs'], acceptance: ['src/old.mjs'], maxRetries: 0 }]
  const revised = structuredClone(definition)
  revised.stages[0].tasks[0] = { ...revised.stages[0].tasks[0], prompt: 'Create a different output', plannedFiles: ['src/new.mjs'], acceptance: ['src/new.mjs'] }
  const state = config()
  Object.assign(state.config.agent.longagent.ultra, { max_rounds: 2, no_progress_rounds: 2, stage_failure: { max_replans: 1 } })
  const result = await execute(f, { plan: definition, replanPlan: revised, configState: state, background: { behavior: payload => { dispatched.push(payload); return null } } })
  assert.notEqual(result.status, 'completed')
  assert.equal(dispatched.length, 1)
  await assert.rejects(access(path.join(f.cwd, 'src/new.mjs')), { code: 'ENOENT' })
  assert.ok((await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra').every(item => item.status === 'blocked'))
  assert.match(result.taskProgress.same.lastError, /definition changed|binding is unavailable/)
})

test('strict Ultra refuses an unresolved seed before any child inference', async t => {
  const f = await fixture(t)
  let requests = 0
  registerProvider('ultra-todo-fixture', { async request() { requests++; throw new Error('must not infer') }, async *requestStream() { requests++; throw new Error('must not infer') } })
  const result = await runWithRuntime({ cwd: f.cwd }, () => runStrictUltraStage({ stage: { stageId: 'strict', tasks: [{ taskId: 'same', prompt: 'Inspect previous effects', plannedFiles: [] }] },
    sessionId: f.sessionId, model: 'fixture', providerType: 'ultra-todo-fixture', configState: config(), toolContext: {},
    seedTaskProgress: { same: { status: 'unknown', lastError: 'prior definition binding unavailable; inspect first' } }, objective: 'Inspect previous effects' }))
  assert.equal(requests, 0)
  assert.equal(result.allSuccess, false)
  assert.equal(result.taskProgress.same.status, 'unknown')
})

test('Ultra replan cancels removed unfinished items even when every retained item is unchanged', async t => {
  const f = await fixture(t), definition = plan()
  definition.goal.criteria = [definition.goal.criteria[0]]
  const revised = structuredClone(definition)
  revised.stages[0].tasks = [revised.stages[0].tasks[0]]
  const state = config()
  Object.assign(state.config.agent.longagent.ultra, { max_rounds: 2, no_progress_rounds: 2, stage_failure: { max_replans: 1 } })
  let h6Count = 0, starts = 0, stateAtReplannedStage = null
  const off = EventBus.subscribe(async event => {
    if (event.sessionId === f.sessionId && event.type === EVENT_TYPES.LONGAGENT_PHASE_CHANGED && event.payload.nextPhase === 'H6') h6Count++
    if (event.sessionId === f.sessionId && event.type === EVENT_TYPES.LONGAGENT_STAGE_STARTED && ++starts === 2) stateAtReplannedStage = await getTodoSnapshot(f.sessionId)
  })
  try {
    await execute(f, { plan: definition, replanPlan: revised, configState: state,
      background: { behavior: payload => /second module/.test(payload.prompt) ? { error: 'EACCES: second fixture operation failed' } : null },
      deps: { runUsabilityGates: async () => h6Count === 1 ? { allPass: false, gates: {}, failures: [{ gate: 'fixture', status: 'fail', reason: 'first controlled gate failure' }] } : { allPass: true, gates: {}, failures: [] } }
    })
  } finally { off() }
  assert.ok(stateAtReplannedStage, 'the retained task stage must actually be revisited')
  assert.equal(stateAtReplannedStage.items.find(item => item.content.includes('"second"')).status, 'cancelled')
})

test('legacy Ultra checkpoint without task-definition binding stays unverified and never replays its completed workers', async t => {
  const f = await fixture(t), definition = plan(), dispatched = []
  definition.stages = [
    { stageId: 'first-stage', name: 'First', tasks: [definition.stages[0].tasks[0]] },
    { stageId: 'second-stage', name: 'Second', tasks: [{ ...definition.stages[0].tasks[1], dependsOn: [] }] }
  ]
  const normalized = validateAndNormalizeStagePlan(definition).plan
  await touchSession({ sessionId: f.sessionId, cwd: f.cwd, mode: 'longagent', model: 'fixture', providerType: 'ultra-todo-fixture' })
  await saveCheckpoint(f.sessionId, { name: 'ultra_latest', stageIndex: 1, stagePlan: normalized, iteration: 1, taskProgress: {
    first: { taskId: 'first', stageId: 'first-stage', status: 'completed', plannedFiles: ['src/first.mjs'], completedFiles: ['src/first.mjs'] },
    second: { taskId: 'second', stageId: 'second-stage', status: 'completed', plannedFiles: ['src/second.mjs'], completedFiles: ['src/second.mjs'] }
  } })
  const state = config()
  state.config.agent.longagent.hybrid.checkpoint_resume = true
  state.config.agent.longagent.resume_incomplete_files = false
  const result = await execute(f, { configState: state, background: { behavior: payload => { dispatched.push(payload); return null } } })
  assert.notEqual(result.status, 'completed')
  assert.equal(dispatched.length, 0)
  assert.ok((await getTodoSnapshot(f.sessionId)).items.filter(item => item.owner.agentId === 'ultra').every(item => item.status === 'blocked'))
  assert.match(result.taskProgress.second.lastError, /binding is unavailable/)
})
