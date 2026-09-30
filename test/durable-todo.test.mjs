import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { touchSession, updateSession, getSession, getTodoSnapshot, updateTodos, appendMessage, appendPart, flushNow, replaceConversationForRewind, forkSession } from '../src/kernel/session/store.mjs'
import { createSessionTodoService } from '../src/kernel/session/todo-service.mjs'
import { emptyTodoSnapshot, reduceTodoSnapshot, readTodoSnapshot } from '../src/kernel/session/todo-state.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createToolRegistry, ToolRegistry } from '../src/kernel/tool/registry.mjs'
import { PermissionEngine } from '../src/kernel/permission/engine.mjs'
import { registerProvider } from '../src/kernel/provider/router.mjs'
import { processTurnLoop } from '../src/kernel/session/loop.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { getSessionTodos } from '../src/sdk/tasks.mjs'
import { createGateway } from '../src/remote/gateway.mjs'
import { MemoryStore } from '../src/remote/store.mjs'
import { identityHash } from '../src/remote/identity.mjs'

const exec = promisify(execFile)
const item = (content, status = 'pending', extra = {}) => ({ content, status, ...extra })
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kk-todo-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = directory
  const sessionId = 'todo-session'
  await touchSession({ sessionId, cwd: directory, mode: 'agent', model: 'fixture', providerType: 'fixture' })
  await touchSession({ sessionId: 'foreign-session', cwd: directory, mode: 'agent', model: 'fixture', providerType: 'fixture' })
  await flushNow()
  t.after(async () => {
    await flushNow()
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, sessionId }
}

test('todo state has stable IDs, explicit states and append-only revisions, not a verified flag', async t => {
  const f = await fixture(t), emitted = []
  const service = await createSessionTodoService({ sessionId: f.sessionId, emit: event => emitted.push(event) })
  const first = await service.update({ todos: [item('Inspect'), item('Implement')] })
  const second = await service.update({ todos: [item('Inspect', 'completed'), item('Implement', 'blocked')] })
  assert.equal(second.revision, 2)
  assert.deepEqual(first.items.map(item => item.id), second.items.map(item => item.id))
  assert.deepEqual(second.items.map(item => item.status), ['completed', 'blocked'])
  const third = await service.update({ todos: [item('Inspect', 'completed', { id: first.items[0].id })] })
  assert.equal(third.items[1].status, 'cancelled')
  assert.equal(emitted.at(-1).payload.snapshot.revision, 3)
  assert.equal(emitted.at(-1).sessionId, f.sessionId)
  assert.deepEqual(await getSessionTodos(f.sessionId), third)
  assert.equal((await getSession(f.sessionId)).parts.filter(part => part.type === 'todo.updated').length, 3)
  for (const unsupported of [{ verified: true }, { status: 'verified' }, { owner: { agentId: 'attacker' } }, { evidenceRefs: [{ kind: 'file', id: '/private/file' }] }]) {
    await assert.rejects(service.update({ todos: [{ ...item('Inspect'), ...unsupported }] }), { code: 'todo_invalid' })
  }
})

test('todo copied tool contexts mutate authoritative service and return the durable snapshot', async t => {
  const f = await fixture(t), registry = createToolRegistry()
  t.after(() => registry.shutdown())
  await registry.initialize({ cwd: f.directory, config: { tool: { sources: { local: false, plugin: false, mcp: false }, browser: { enabled: false } } } })
  const todoService = await createSessionTodoService({ sessionId: f.sessionId, emit: () => {} })
  const context = { sessionId: f.sessionId, todoService, _todoState: [] }
  for (const mode of ['plan', 'agent', 'auto', 'ultra', 'yolo']) for (const name of ['todowrite', 'todo_read']) assert.ok((await registry.list({ mode })).some(tool => tool.name === name))
  const first = await registry.call('todowrite', { todos: [item('Run tests', 'in_progress')] }, { ...context, mode: 'plan' })
  assert.equal(first.status, 'completed')
  assert.equal(JSON.parse(first.output).items[0].status, 'in_progress')
  assert.equal((await todoService.list()).items[0].status, 'in_progress')
  assert.deepEqual(context._todoState, []) // Compatibility copy is not authoritative.
  const second = await registry.call('todowrite', { todos: [item('Run tests', 'completed')] }, { ...context })
  assert.equal(JSON.parse(second.output).revision, 2)
  assert.equal((await getTodoSnapshot(f.sessionId)).items[0].status, 'completed')
  assert.equal((await registry.call('todowrite', { todos: [] }, { ...context, sessionId: 'foreign-session' })).status, 'error')
  assert.equal((await registry.call('todowrite', { todos: [] }, { ...context, todoService: { update: () => ({ verified: true }) } })).status, 'error')
  const conflict = await registry.call('todowrite', { expectedRevision: 0, todos: [] }, { ...context })
  assert.equal(conflict.status, 'blocked')
  assert.equal(JSON.parse(conflict.output).updated, false)
  assert.equal(JSON.parse(conflict.output).snapshot.revision, 2)
  assert.equal((await getTodoSnapshot(f.sessionId)).revision, 2)
  const read = await registry.call('todo_read', {}, { ...context })
  assert.equal(read.status, 'completed')
  assert.equal(JSON.parse(read.output).revision, 2)
  assert.equal((await registry.call('todo_read', { sessionId: 'foreign-session' }, { ...context })).status, 'error')
  assert.equal((await registry.call('todo_read', {}, { ...context, sessionId: 'foreign-session' })).status, 'error')
})

test('todo writers use captured CAS revisions; list does not silently bless a stale update', async t => {
  const f = await fixture(t)
  const left = await createSessionTodoService({ sessionId: f.sessionId, emit: () => {} })
  const right = await createSessionTodoService({ sessionId: f.sessionId, emit: () => {} })
  const writes = await Promise.allSettled([left.update({ todos: [item('Left')] }), right.update({ todos: [item('Right')] })])
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(writes.find(result => result.status === 'rejected').reason.code, 'todo_conflict')
  const stale = writes[0].status === 'fulfilled' ? right : left
  assert.equal((await stale.list()).revision, 1)
  await assert.rejects(stale.update({ todos: [] }), { code: 'todo_conflict' })
  await stale.list({ refresh: true })
  assert.equal((await stale.update({ todos: [] })).revision, 2)
})

test('todo event delivery and caller snapshots cannot corrupt the writer revision or durable result', async t => {
  const f = await fixture(t)
  const service = await createSessionTodoService({ sessionId: f.sessionId, emit: event => { event.payload.snapshot.revision = 999; throw new Error('transport disconnected') } })
  const first = await service.update({ todos: [item('Transport-independent')] })
  assert.equal(first.revision, 1)
  first.revision = 888
  first.items[0].content = 'Mutated caller copy'
  assert.equal((await getTodoSnapshot(f.sessionId)).items[0].content, 'Transport-independent')
  assert.equal((await service.update({ todos: [item('Transport-independent', 'completed')] })).revision, 2)
})

test('todo writes are session/agent owned, dependencies acyclic and evidence is same-shard only', async t => {
  const f = await fixture(t), service = await createSessionTodoService({ sessionId: f.sessionId, emit: () => {} })
  const message = await appendMessage(f.sessionId, 'assistant', 'Observed tool output')
  const part = await appendPart(f.sessionId, { type: 'tool-result', output: 'fixture result' })
  const foreign = await appendMessage('foreign-session', 'assistant', 'Other evidence')
  const first = await service.update({ todos: [item('Inspect', 'pending', { evidenceRefs: [{ kind: 'message', id: message.id }, { kind: 'part', id: part.id }] }), item('Implement')] })
  const [a, b] = first.items
  await assert.rejects(service.update({ todos: [item('Inspect', 'completed', { id: a.id, evidenceRefs: [{ kind: 'message', id: foreign.id }] })] }), { code: 'todo_scope' })
  await assert.rejects(service.update({ todos: [item('Inspect', 'pending', { id: a.id, dependencies: [b.id] }), item('Implement', 'pending', { id: b.id, dependencies: [a.id] })] }), { code: 'todo_invalid' })
  await assert.rejects(service.update({ todos: [item('Inspect', 'pending', { id: a.id, dependencies: ['foreign-id'] })] }), { code: 'todo_scope' })
  const child = await createSessionTodoService({ sessionId: f.sessionId, agentId: 'qa:审查员', emit: () => {} })
  await assert.rejects(child.update({ todos: [item('Stolen', 'completed', { id: a.id })] }), { code: 'todo_scope' })
  const added = await child.update({ todos: [item('Independent worker')] })
  assert.equal(added.items.length, 3)
  assert.equal(added.items[0].owner.agentId, 'qa:审查员')
  assert.equal(added.items.find(item => item.id === a.id).status, 'pending')
  await assert.rejects(runWithRuntime({ sessionId: 'foreign-session' }, () => service.update({ todos: [] })), { code: 'todo_scope' })
  await assert.rejects(service.update({ sessionId: 'foreign-session', todos: [] }), { code: 'todo_invalid' })
})

test('todo persistence survives process exit and rejects concurrent process stale CAS', async t => {
  const f = await fixture(t)
  const module = new URL('../src/kernel/session/store.mjs', import.meta.url).href
  const program = `import { updateTodos } from ${JSON.stringify(module)}; try { const result = await updateTodos('todo-session',{expectedRevision:0,todos:[{content:process.argv[1],status:'pending'}]}); console.log(JSON.stringify({revision:result.revision})); } catch(error) { console.log(JSON.stringify({code:error.code})); }`
  const results = await Promise.all(['one', 'two'].map(name => exec(process.execPath, ['--input-type=module', '-e', program, name], { env: { ...process.env, KKCODE_HOME: f.directory } })))
  const values = results.map(result => JSON.parse(result.stdout.trim()))
  assert.equal(values.filter(result => result.revision === 1).length, 1)
  assert.equal(values.filter(result => result.code === 'todo_conflict').length, 1)
  const read = `import {getTodoSnapshot} from ${JSON.stringify(module)}; console.log(JSON.stringify(await getTodoSnapshot('todo-session')))`
  const recovered = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', read], { env: { ...process.env, KKCODE_HOME: f.directory } })).stdout)
  assert.deepEqual(recovered, await getTodoSnapshot(f.sessionId))
  assert.equal(JSON.parse(await readFile(join(f.directory, 'sessions', `${f.sessionId}.json`), 'utf8')).parts.length, 1)
})

test('rewind appends monotonic restoration and fork does not inherit another owner todo capability', async t => {
  const f = await fixture(t)
  await appendMessage(f.sessionId, 'user', 'First', { turnId: 'turn_one' })
  const first = await updateTodos(f.sessionId, { expectedRevision: 0, todos: [item('First task')] }, { turnId: 'turn_one' })
  await appendMessage(f.sessionId, 'assistant', 'First response', { turnId: 'turn_one' })
  const retained = (await getSession(f.sessionId)).messages
  await appendMessage(f.sessionId, 'user', 'Second', { turnId: 'turn_two' })
  await updateTodos(f.sessionId, { expectedRevision: 1, todos: [item('First task', 'completed', { id: first.items[0].id }), item('Second task')] }, { turnId: 'turn_two' })
  const observed = (await getSession(f.sessionId)).messages
  await replaceConversationForRewind(f.sessionId, retained, observed)
  const restored = await getTodoSnapshot(f.sessionId)
  assert.equal(restored.revision, 3)
  assert.equal(restored.source.kind, 'rewind')
  assert.equal(restored.items.length, 1)
  assert.equal(restored.items[0].status, 'pending')
  assert.ok(restored.items[0].revision > first.items[0].revision)
  assert.equal((await getSession(f.sessionId)).parts.filter(part => part.type === 'todo.updated').length, 3)
  await appendMessage(f.sessionId, 'user', 'Unrelated third turn', { turnId: 'turn_three' })
  await replaceConversationForRewind(f.sessionId, retained, (await getSession(f.sessionId)).messages)
  assert.equal((await getTodoSnapshot(f.sessionId)).revision, 3) // Unrelated rewind does not create a fake state change.
  await forkSession({ sessionId: f.sessionId, newSessionId: 'fork-session' })
  assert.equal((await getTodoSnapshot('fork-session')).revision, 0)
  await replaceConversationForRewind(f.sessionId, [], retained)
  const empty = await getTodoSnapshot(f.sessionId)
  assert.equal(empty.revision, 4)
  assert.deepEqual(empty.items, [])
  assert.equal((await getSession(f.sessionId)).parts.filter(part => part.type === 'todo.updated').length, 4)
})

test('cancelled writes and malformed or discontinuous journals fail closed', async t => {
  const f = await fixture(t), controller = new AbortController()
  controller.abort()
  await assert.rejects(updateTodos(f.sessionId, { expectedRevision: 0, todos: [item('never written')] }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal((await getTodoSnapshot(f.sessionId)).revision, 0)
  const first = reduceTodoSnapshot(emptyTodoSnapshot(f.sessionId), { expectedRevision: 0, todos: [item('one')] }, { sessionId: f.sessionId })
  assert.throws(() => readTodoSnapshot([{ type: 'todo.updated', snapshot: { ...first, revision: 2 } }], f.sessionId))
  assert.throws(() => readTodoSnapshot([{ type: 'todo.updated', snapshot: first }], 'foreign-session'))
  assert.throws(() => readTodoSnapshot([{ type: 'todo.updated', snapshot: first }, { type: 'todo.updated', snapshot: first }], f.sessionId))
  assert.throws(() => reduceTodoSnapshot(first, { expectedRevision: 1, todos: Array.from({ length: 101 }, (_, index) => item(`task ${index}`)) }, { sessionId: f.sessionId }), { code: 'todo_invalid' })
})

test('remote todos.list is read-only, same-snapshot recovery and replay are session scoped', async t => {
  const f = await fixture(t), device = await new DeviceService({ cwd: f.directory, roots: [f.directory] }).initialize()
  t.after(() => device.close())
  await device.bindOwner('owner')
  const principal = { id: 'owner', client: 'owner-client' }
  const request = (method, params, who = principal, requestId = randomUUID()) => device.request({ id: requestId, method, params }, who)
  const service = await createSessionTodoService({ sessionId: f.sessionId, emit: event => device.record(event) })
  const snapshot = await service.update({ todos: [item('Read-only progress', 'completed')] })
  assert.deepEqual(await request('todos.list', { sessionId: f.sessionId }), snapshot)
  assert.deepEqual((await request('sessions.get', { sessionId: f.sessionId })).todos, snapshot)
  const events = await request('events.list', { sessionId: f.sessionId, after: 0 })
  assert.deepEqual(events.events.find(event => event.type === 'todo.updated').payload.snapshot, snapshot)
  assert.deepEqual((await request('todos.list', { sessionId: 'foreign-session' })).items, [])
  await assert.rejects(request('todos.list', { sessionId: f.sessionId }, { id: 'intruder', client: 'bad' }), { code: 'forbidden' })
  for (const extra of [{ verified: true }, { accountId: 'other' }, { owner: 'other' }, { cwd: '/private' }]) await assert.rejects(request('todos.list', { sessionId: f.sessionId, ...extra }), { code: 'todo_invalid' })
  await assert.rejects(request('todos.update', { sessionId: f.sessionId, todos: [] }), { code: 'unknown_method' })
  // Read requests are never mutation-ledger cached; a reused request ID returns current state.
  const requestId = randomUUID()
  assert.equal((await request('todos.list', { sessionId: f.sessionId }, principal, requestId)).revision, 1)
  await service.update({ todos: [item('Read-only progress', 'blocked')] })
  assert.equal((await request('todos.list', { sessionId: f.sessionId }, principal, requestId)).revision, 2)
  assert.ok((await request('status', {})).features.includes('todos.v1'))
  await touchSession({ sessionId: 'child-session', cwd: f.directory, mode: 'agent', model: 'fixture', providerType: 'fixture', parentSessionId: f.sessionId })
  await updateSession('child-session', { childContract: { schema: 1, parentSessionId: f.sessionId, runSpec: { role: { name: 'review' } }, prompt: 'PRIVATE-CHILD-PROMPT' },
    childStatus: 'running', childMailbox: [{ text: 'PRIVATE-MAILBOX' }], childResult: { secret: 'PRIVATE-RESULT' } })
  const parent = await request('sessions.get', { sessionId: f.sessionId })
  assert.deepEqual(parent.subagents, [{ session_id: 'child-session', parent_session_id: f.sessionId, subagent: 'review', status: 'running', background_task_id: null, pending_messages: 1 }])
  for (const hidden of ['PRIVATE-CHILD-PROMPT', 'PRIVATE-MAILBOX', 'PRIVATE-RESULT']) assert.equal(JSON.stringify(parent).includes(hidden), false)
  assert.deepEqual((await request('sessions.get', { sessionId: 'foreign-session' })).subagents, [])
})

async function controlledTurn(f, responses, options = {}) {
  const inputs = []
  registerProvider('todo-fixture', {
    async request(input) { inputs.push(input); return responses[Math.min(inputs.length - 1, responses.length - 1)] },
    async *requestStream() { throw new Error('Controlled provider stream was not enabled') }
  })
  const configState = { config: {
    provider: { default: 'todo-fixture', 'todo-fixture': { default_model: 'test', timeout_ms: 5000, stream: false } },
    agent: { default_mode: 'agent', max_steps: 8, verify_completion: options.verifyCompletion !== false },
    permission: { default_policy: 'allow', rules: [] }, session: { max_history: 30, recovery: false },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false }, browser: { enabled: false } },
    usage: { aggregation: ['turn'], budget: {} }, ui: { markdown_render: false }
  } }
  await ToolRegistry.initialize({ cwd: f.directory, config: configState.config })
  PermissionEngine.setTrusted(true)
  try {
    const result = await runWithRuntime({ cwd: f.directory }, () => processTurnLoop({ prompt: 'Track the requested work accurately', mode: options.mode || 'agent',
      model: 'test', providerType: 'todo-fixture', sessionId: f.sessionId, configState,
      // A caller-supplied copy must not override actual session/tool capability.
      toolContext: { sessionId: 'foreign-session', _todoState: [item('Fake completion', 'completed')], todoService: { update: () => { throw new Error('untrusted capability used') } } } }))
    return { result, inputs }
  } finally { PermissionEngine.setTrusted(false) }
}
const response = (text = '', toolCalls = []) => ({ text, toolCalls, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } })

test('controlled Plan provider can update/read durable state but cannot write project files', async t => {
  const f = await fixture(t)
  const { result } = await controlledTurn(f, [
    response('', [{ id: 'plan_todo', name: 'todowrite', args: { todos: [item('Design only', 'in_progress')] } },
      { id: 'plan_write', name: 'write', args: { path: 'not-authorized.txt', content: 'must never be written' } }]),
    response('', [{ id: 'plan_read', name: 'todo_read', args: {} }]),
    response('Plan recorded; implementation has not run.')
  ], { mode: 'plan', verifyCompletion: false })
  assert.equal(result.toolEvents.find(event => event.name === 'todowrite').status, 'completed')
  assert.equal(result.toolEvents.find(event => event.name === 'todo_read').status, 'completed')
  assert.notEqual(result.toolEvents.find(event => event.name === 'write').status, 'completed')
  assert.equal((await getTodoSnapshot(f.sessionId)).items[0].content, 'Design only')
  assert.deepEqual((await getTodoSnapshot('foreign-session')).items, [])
  await assert.rejects(access(join(f.directory, 'not-authorized.txt')), { code: 'ENOENT' })
})

test('controlled provider completion validation reads actual todos, not the copied legacy context', async t => {
  const f = await fixture(t)
  const { result, inputs } = await controlledTurn(f, [
    response('', [{ id: 'track_pending', name: 'todowrite', args: { todos: [item('Inspect fixture')] } }]),
    response('Everything is done.'),
    response('', [{ id: 'track_completed', name: 'todowrite', args: { expectedRevision: 1, todos: [item('Inspect fixture', 'completed')] } }]),
    response('Authored task complete; no tests were executed.')
  ])
  assert.equal(inputs.length, 4)
  assert.match(JSON.stringify(inputs[2]), /TASK VERIFICATION FAILED|任务验证失败/)
  assert.equal((await getTodoSnapshot(f.sessionId)).revision, 2)
  assert.equal(result.reply, 'Authored task complete; no tests were executed.')
  assert.equal(result.verification?.verdict, 'NO_BLOCKING_TODO')
  assert.match(result.verification?.message || '', /not proof that tests passed/)
})

test('actual relay todo reads honor exact shared session and in-flight revocation', { timeout: 20000 }, async t => {
  const f = await fixture(t), service = await new DeviceService({ cwd: f.directory, roots: [f.directory] }).initialize(), store = new MemoryStore()
  t.after(() => service.close())
  await service.bindOwner('owner', { organization: 'QA' })
  await updateTodos(f.sessionId, { expectedRevision: 0, todos: [item('Private authored progress')] })
  const owner = { id: 'owner', organization: 'QA' }, viewer = { id: 'viewer', organization: 'QA' }
  for (const account of [owner, viewer]) await store.put(`account:${account.id}`, account)
  for (const [id, kind, account] of [['device', 'device', owner], ['viewer', 'client', viewer]]) {
    await store.put(`identity-session:${id}`, { id, kind, accountId: account.id, deviceId: kind === 'device' ? service.metadata.id : null, expires: Date.now() + 60000 })
    await store.put(`token:${identityHash(id)}`, { sessionId: id, kind, account, expires: Date.now() + 60000 })
  }
  const deviceKey = `device:${service.metadata.id}`
  await store.put(deviceKey, { id: service.metadata.id, name: 'Todo fixture', owner: 'owner', organization: 'QA', shares: { viewer: { [f.sessionId]: 'view' } } })
  const app = await createGateway({ origin: 'http://localhost', issuer: 'https://idp.invalid', oidcConfig: {}, store, dev: true, organization: 'QA' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/relay/device', { headers: { Host: 'localhost', Authorization: 'Bearer device' } })
  t.after(async () => { socket.terminate(); await app.close() })
  await once(socket, 'open')
  const registration = once(socket, 'message'); socket.send(JSON.stringify({ type: 'register', device: service.metadata })); await registration
  let entering, release
  const entered = new Promise(resolve => { entering = resolve }), resumed = new Promise(resolve => { release = resolve })
  socket.on('message', async raw => {
    const message = JSON.parse(raw)
    if (message.type !== 'request') return
    try {
      const result = await service.request(message.request, message.principal)
      if (message.request.id === 'revoked-todo') { entering(); await resumed }
      socket.send(JSON.stringify({ type: 'response', id: message.id, result }))
    } catch (error) { socket.send(JSON.stringify({ type: 'response', id: message.id, error: { code: error.code, message: error.message }, status: error.status || 400 })) }
  })
  const rpc = (method, params = {}, id = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/devices/${service.metadata.id}/rpc`, headers: { host: 'localhost', authorization: 'Bearer viewer' }, payload: { id, method, params } })
  const got = await rpc('todos.list', { sessionId: f.sessionId })
  assert.equal(got.statusCode, 200, got.body)
  assert.equal(got.json().result.items[0].content, 'Private authored progress')
  assert.equal((await rpc('todos.list', { sessionId: 'foreign-session' })).statusCode, 403)
  assert.equal((await rpc('todos.list', { sessionId: f.sessionId, accountId: 'other' })).statusCode, 400)
  assert.ok((await rpc('status')).json().result.features.includes('todos.v1'))
  const waiting = rpc('sessions.get', { sessionId: f.sessionId }, 'revoked-todo')
  await entered
  const device = await store.get(deviceKey)
  await store.put(deviceKey, { ...device, shares: {} })
  release()
  const denied = await waiting
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().result, undefined)
  assert.equal(JSON.stringify([...store.data]).includes('Private authored progress'), false)
})
