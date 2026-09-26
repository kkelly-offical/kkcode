import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createDelegatedKernel } from '../src/kernel/isolation/delegation-kernel.mjs'
import { createRunCoordinator, hasUnresolvedSessionRun } from '../src/kernel/orchestration/run-coordinator.mjs'
import { createDurableRunBinding, withDurableRun, currentDurableRun } from '../src/kernel/orchestration/run-runtime.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { createDockerExecutionBackend } from '../src/kernel/isolation/docker-executor.mjs'
import { getSession, replaceMessages, flushNow } from '../src/kernel/session/store.mjs'
import { budgetRoute } from '../src/usage/budget-profiles.mjs'
import { toolPreDispatchError } from '../src/kernel/core/execution-outcome.mjs'

const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const actor = { accountId: 'fixture-account', projectId: 'fixture-project' }
const contract = { objective: 'Create a test file, preserve the main workspace, do not publish', allowedPaths: ['.'], allowedTools: ['write', 'read'], allowedExternalActions: ['forge.comment'], requiredCriteria: [{ id: 'checks', description: 'Host checks must pass' }] }
const toolReply = { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'created.txt', content: 'created by the actual tool\n' }) } }] }
const finalReply = { role: 'assistant', content: 'Done; all work is complete.' }

function config(baseUrl) {
  return { config: {
    provider: { default: 'fixture', fixture: { type: 'openai', base_url: baseUrl, api_key: '', api_key_env: '', default_model: 'fixture-model', stream: false, timeout_ms: 3000, context_limit: 131072, max_tokens: 1000 } },
    agent: { default_mode: 'agent', max_steps: 3 }, permission: { default_policy: 'allow', rules: [] },
    session: { max_history: 30, recovery: false, title_generation: false },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
    usage: { aggregation: ['turn'], budget: {} }, ui: { markdown_render: false }, skills: { enabled: false, auto_seed: false }
  } }
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-coordinator-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'private')
  const main = path.join(root, 'main'), cwd = path.join(root, 'task')
  await mkdir(main); await writeFile(path.join(main, 'README.md'), 'baseline\n')
  await exec('git', ['init', '-q'], { cwd: main })
  await exec('git', ['add', '.'], { cwd: main })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: main })
  await exec('git', ['worktree', 'add', '--detach', cwd, 'HEAD'], { cwd: main })
  let requests = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    try { options.validateRequest?.(body) } catch (error) {
      response.statusCode = 400; response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ error: { message: error.message, type: 'invalid_tool_pairing' } })); return
    }
    if (request.url.endsWith('/count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ input_tokens: 42 })); return }
    const message = options.responses?.[requests] || (requests === 0 ? toolReply : finalReply)
    requests++
    response.setHeader('Content-Type', 'application/json')
    if (options.protocol === 'anthropic') response.end(JSON.stringify({ id: `fixture-${requests}`, type: 'message', role: 'assistant', model: 'fixture-model', content: message.tool_calls ? message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })) : [{ type: 'text', text: message.content }], stop_reason: message.tool_calls ? 'tool_use' : 'end_turn', usage: { input_tokens: 12, output_tokens: 5 } }))
    else response.end(JSON.stringify({ id: `fixture-${requests}`, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const state = config(baseUrl)
  const pricing = path.join(root, 'fixture-prices.json')
  await writeFile(pricing, JSON.stringify({ models: { 'fixture-model': { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  state.source = { userDir: root, userRaw: { usage: { pricing_file: pricing } } }
  if (options.protocol) state.config.provider.fixture.type = options.protocol
  if (options.permission) state.config.permission = options.permission
  const kernel = await createDelegatedKernel({ cwd, configState: state, trustState: { trusted: true }, handlers: { onPermissionPrompt: () => 'allow_once' } })
  const storeDirectory = path.join(root, 'runs')
  const store = await openRunStore({ directory: storeDirectory })
  const artifacts = createArtifactStore({ root: path.join(root, 'artifacts') })
  const backend = options.backend || { allowedToolNames: ['write', 'read'], ensureReady: async () => ({ strict: true, backend: 'fixture-host-controlled' }), executeTool: async ({ invoke }) => invoke() }
  const authorize = options.authorize || (() => true)
  const rawCoordinator = createRunCoordinator({ kernel, store, artifacts, actor: options.actor || actor, ownerId: 'fixture-host', authorize, executionBackend: backend, verifyDeliveryBinding: options.verifyDeliveryBinding, leaseDirectory: path.join(root, 'leases'), grantDirectory: path.join(root, 'grants') })
  const coordinator = { ...rawCoordinator, start: input => rawCoordinator.start({ limits: { budgetUsd: 10, deadlineAt: Date.now() + 60000 }, ...input }) }
  t.after(async () => {
    await coordinator.close(); await kernel.shutdown(); await store.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { root, cwd, main, kernel, store, artifacts, coordinator, backend, authorize, baseUrl, storeDirectory, requests: () => requests }
}

test('durable binding is a host capability, not a JSON flag', () => {
  assert.equal(runWithRuntime({ durableRun: { runId: 'forged', prepareTool() {} } }, currentDurableRun), null)
  assert.throws(() => withDurableRun({ runId: 'forged' }, () => {}), /trusted host/)
  const binding = createDurableRunBinding({ runId: 'real' })
  assert.equal(withDurableRun(binding, currentDurableRun), binding)
})

test('caller mutation during approval cannot raise the original zero budget or extend its deadline', async t => {
  const originalDeadline = Date.now() + 60000, limits = { budgetUsd: 0, deadlineAt: originalDeadline }
  const f = await setup(t, { authorize: request => {
    if (request.kind === 'run.contract') {
      assert.equal(request.limits.budgetUsd, 0)
      limits.budgetUsd = 100; limits.deadlineAt += 3600000
    }
    return true
  } })
  const run = await f.coordinator.start({ contract, limits })
  const budget = await f.store.getRunBudget({ runId: run.id })
  assert.equal(budget.budgetUsd, 0)
  assert.equal(budget.deadlineAt, originalDeadline)
  assert.equal(f.requests(), 0)
})

test('caller mutation during input persistence cannot expand a validated per-turn budget', async t => {
  const f = await setup(t, { responses: [finalReply] })
  const run = await f.coordinator.start({ contract })
  const limits = { budgetUsd: 0.000001, deadlineAt: run.budget.deadlineAt }
  let changed = false
  const put = f.artifacts.put.bind(f.artifacts)
  f.artifacts.put = async input => {
    if (input.source.kind === 'user') {
      changed = true
      limits.budgetUsd = 10
      limits.deadlineAt += 3600000
    }
    return put(input)
  }
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'Do not exceed this narrower turn budget.', limits })
  assert.equal(changed, true)
  assert.equal(f.requests(), 0, 'the full run budget must not replace the caller’s original narrower turn budget')
  assert.equal(result.budget.requests.length, 0)
  const page = await f.artifacts.read({ actor: { ...actor, runId: run.id, sessionId: run.binding.sessionId }, id: result.run.lastTurn.inputArtifactRef })
  const saved = JSON.parse(Buffer.from(page.data, 'base64').toString('utf8'))
  assert.equal(saved.limits.budgetUsd, 0.000001)
  assert.equal(saved.limits.deadlineAt, run.budget.deadlineAt)
})

test('account scope is detached for the coordinator lifetime and explicit in host approval', async t => {
  const original = { ...actor }, suppliedActor = { ...actor }
  let approvedActor
  const f = await setup(t, { actor: suppliedActor, authorize: request => {
    if (request.kind === 'run.contract') {
      approvedActor = request.actor
      suppliedActor.accountId = 'different-account'
      suppliedActor.projectId = 'different-project'
    }
    return true
  } })
  const run = await f.coordinator.start({ contract })
  assert.equal(run.binding.accountId, original.accountId)
  assert.equal(run.binding.projectId, original.projectId)
  assert.deepEqual(approvedActor, original)
  assert.equal(Object.isFrozen(approvedActor), true)
  assert.equal((await f.coordinator.inspect(run.id)).id, run.id)
  const page = await f.artifacts.read({ actor: { ...original, runId: run.id, sessionId: run.binding.sessionId }, id: run.binding.contractApprovalRef })
  assert.ok(JSON.parse(Buffer.from(page.data, 'base64').toString('utf8')).approval.approved)
})

test('persistent route scope follows the actual credential value, not only its environment variable name', t => {
  const name = 'KKCODE_ROUTE_ROTATION_TEST_KEY', previous = process.env[name]
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
  const state = { config: { provider: { default: 'rotation', rotation: { type: 'openai', base_url: 'https://model.example.invalid/v1', api_key_env: name, default_model: 'fixed-model', context_limit: 131072, max_tokens: 1000 } } } }
  process.env[name] = 'synthetic-original-value'
  const first = budgetRoute(state, { providerType: 'rotation', model: 'fixed-model' }).scopeHash
  process.env[name] = 'synthetic-rotated-value'
  const second = budgetRoute(state, { providerType: 'rotation', model: 'fixed-model' }).scopeHash
  assert.notEqual(first, second)
  assert.match(second, /^[a-f0-9]{64}$/)
})

test('external verification persists exactly the detached receipt it checked, not later caller mutations', async t => {
  let entered, release
  const waiting = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const f = await setup(t, { verifyDeliveryBinding: async ({ receipt }) => {
    assert.equal(receipt.status, 'draft'); assert.equal(Object.isFrozen(receipt), true)
    assert.equal(Object.isFrozen(receipt.checks), true); entered(); await gate; return true
  } })
  let run = await f.coordinator.start({ contract: { ...contract, requiredCriteria: [{ id: 'remote', description: 'Actual remote readiness' }] } })
  run = await f.store.setCandidate({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, candidateHash: hash('candidate') })
  const original = { runId: run.id, repositoryId: 'fixture/repository', candidateSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), status: 'draft', checks: [{ status: 'pending' }] }
  const input = { runId: run.id, criterionId: 'remote', inspectDelivery: async () => original }
  const pending = f.coordinator.recordDeliveryReceipt(input)
  await waiting
  original.status = 'mergeable'; original.checks[0].status = 'success'; input.criterionId = 'different'
  release()
  const result = await pending, receipt = result.verifications.at(-1)
  assert.equal(receipt.criterionId, 'remote'); assert.equal(receipt.status, 'unknown')
  const page = await f.artifacts.read({ actor: { ...actor, sessionId: run.binding.sessionId, runId: run.id }, id: receipt.evidenceRefs[0] })
  const saved = JSON.parse(Buffer.from(page.data, 'base64').toString('utf8'))
  assert.equal(saved.status, 'draft'); assert.equal(saved.checks[0].status, 'pending')
})

test('external verification cannot attach an old platform receipt to a candidate changed during artifact persistence', async t => {
  const f = await setup(t, { verifyDeliveryBinding: async () => true })
  let run = await f.coordinator.start({ contract: { ...contract, requiredCriteria: [{ id: 'remote', description: 'Actual remote readiness' }] } })
  run = await f.store.setCandidate({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, candidateHash: hash('first-candidate') })
  let entered, release
  const waiting = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const put = f.artifacts.put.bind(f.artifacts)
  f.artifacts.put = async input => { entered(); await gate; return put(input) }
  const pending = f.coordinator.recordDeliveryReceipt({ runId: run.id, criterionId: 'remote', inspectDelivery: async () => ({
    runId: run.id, repositoryId: 'fixture/repository', candidateSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), status: 'mergeable',
  }) })
  pending.catch(() => {})
  await waiting
  try {
    await f.store.setCandidate({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, candidateHash: hash('different-candidate') })
  } finally { release() }
  await assert.rejects(pending, { code: 'REVISION_CONFLICT' })
  const current = await f.store.getRun(run.id)
  assert.equal(current.candidateHash, hash('different-candidate'))
  assert.equal(current.verifications.length, 0, 'old proof must not certify the replacement candidate')
})

test('real HTTP provider and kernel tool execution persist intent and full result; prose cannot finish run', async t => {
  const f = await setup(t)
  const run = await f.coordinator.start({ contract })
  const output = await f.coordinator.execute({ runId: run.id, prompt: contract.objective })
  assert.equal(output.run.state, 'waiting_input', JSON.stringify(output.turn))
  assert.equal(output.verified, false)
  assert.equal(output.run.actions.length, 1, JSON.stringify(output.turn.toolEvents))
  assert.equal(output.run.actions[0].state, 'succeeded')
  assert.match(await readFile(path.join(f.cwd, 'created.txt'), 'utf8'), /actual tool/)
  await assert.rejects(readFile(path.join(f.main, 'created.txt')), { code: 'ENOENT' })
  const evidence = output.run.actions[0].receipt.evidenceRefs
  assert.ok(evidence.length >= 2)
  for (const id of evidence) await f.artifacts.getMetadata({ actor: { ...actor, runId: run.id, sessionId: run.binding.sessionId }, id })
  const events = await f.store.events({ runId: run.id })
  assert.ok(events.findIndex(event => event.type === 'action.prepared') < events.findIndex(event => event.type === 'action.settled'))
  assert.equal(output.run.lastTurn.status, 'waiting_input')
  const inputPage = await f.artifacts.read({ actor: { ...actor, runId: run.id, sessionId: run.binding.sessionId }, id: output.run.lastTurn.inputArtifactRef, limit: 65536 })
  const input = JSON.parse(Buffer.from(inputPage.data, 'base64').toString())
  assert.deepEqual(Object.keys(input.routeIdentity).sort(), ['model', 'provider', 'scopeHash'])
  assert.equal(input.routeIdentity.scopeHash, budgetRoute(f.kernel.configState, { providerType: 'fixture', model: 'fixture-model' }).scopeHash)
  await assert.rejects(f.coordinator.complete({ runId: run.id }), { code: 'VERIFICATION_REQUIRED' })
  await assert.rejects(f.coordinator.verifiedCandidate({ runId: run.id }), { code: 'VERIFICATION_REQUIRED' })
  assert.equal(await hasUnresolvedSessionRun(run.binding.sessionId, { store: f.store }), true)
})

test('actual Docker backend and actual kernel persist a container-only tool result', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 60_000 }, async t => {
  const strict = createDockerExecutionBackend({ image: process.env.KKCODE_STRICT_TEST_IMAGE })
  const backend = { ...strict, executeTool: call => strict.executeTool({ ...call, invoke: () => { throw new Error('strict writes must never invoke the host implementation') } }) }
  const f = await setup(t, { backend })
  const run = await f.coordinator.start({ contract })
  assert.equal(run.state, 'waiting_input')
  assert.equal(run.lastTurn, null)
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'create the file through the controlled container' })
  assert.equal(result.run.actions[0]?.state, 'succeeded', JSON.stringify(result.turn))
  assert.match(await readFile(path.join(f.cwd, 'created.txt'), 'utf8'), /actual tool/)
  assert.equal(result.run.state, 'waiting_input')
})

test('strict pre-dispatch path rejection is not_applied and the model can correct the next tool call', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 60_000 }, async t => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'kk-rejected-write-'))
  t.after(() => rm(outsideRoot, { recursive: true, force: true }))
  const outside = path.join(outsideRoot, 'subject-test.mjs')
  const rejected = { role: 'assistant', content: null, tool_calls: [{ id: 'outside-write', type: 'function', function: {
    name: 'write', arguments: JSON.stringify({ path: outside, content: 'must never leave the task workspace' })
  } }] }
  let errorReturned = false
  const f = await setup(t, { backend: createDockerExecutionBackend({ image: process.env.KKCODE_STRICT_TEST_IMAGE }),
    responses: [rejected, toolReply, finalReply], validateRequest(body) {
      if (body.messages.some(message => message.role === 'tool' && String(message.content).includes('outside'))) errorReturned = true
    } })
  const run = await f.coordinator.start({ contract })
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'Use workspace-relative paths after any path validation error.' })
  assert.equal(result.run.state, 'waiting_input', JSON.stringify(result.turn))
  assert.equal(result.turn.error, null)
  assert.equal(f.requests(), 3)
  assert.equal(errorReturned, true, 'the next model request must receive the actual correctable path error')
  assert.equal(result.turn.toolEvents[0].status, 'error')
  assert.match(result.turn.toolEvents[0].output, /执行前被拒绝，未写入目标文件/)
  assert.match(result.turn.toolEvents[0].output, /\/workspace\/\.\.\./)
  assert.deepEqual(result.run.actions.map(action => action.state), ['not_applied', 'succeeded'])
  assert.match(result.run.actions[0].receipt.summary, /workspace_path_violation/)
  await assert.rejects(readFile(outside), { code: 'ENOENT' })
  assert.match(await readFile(path.join(f.cwd, 'created.txt'), 'utf8'), /actual tool/)
  assert.ok(result.budget.requests.every(request => request.status === 'settled'))
})

test('a backend error cannot forge a no-effect receipt with a JSON flag or workspace error code', async t => {
  const f = await setup(t, { backend: {
    allowedToolNames: ['write'], ensureReady: async () => ({ strict: true }),
    executeTool: async ({ args, context }) => {
      await writeFile(path.join(context.cwd, 'actual-effect.txt'), args.content)
      throw Object.assign(new Error('Untrusted claim after a real side effect'), { operationNotStarted: true, code: 'workspace_path_violation' })
    }
  } })
  const run = await f.coordinator.start({ contract })
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'Attempt once; a thrown claim is not trusted proof.' })
  assert.match(await readFile(path.join(f.cwd, 'actual-effect.txt'), 'utf8'), /actual tool/)
  assert.equal(result.run.actions[0].state, 'unknown')
  assert.equal(result.run.state, 'outcome_unknown')
  assert.equal(f.requests(), 1, 'an unknown actual side effect must still stop automatic continuation')
})

test('host refusal and main workspace are rejected before model execution', async t => {
  const f = await setup(t, { authorize: () => false })
  await assert.rejects(f.coordinator.start({ contract }), { code: 'APPROVAL_REQUIRED' })
  assert.equal((await f.store.listRuns()).length, 0)
  assert.equal(f.requests(), 0)
  const kernel = await createDelegatedKernel({ cwd: f.main, configState: config(f.baseUrl), trustState: { trusted: true } })
  const coordinator = createRunCoordinator({ kernel, store: f.store, artifacts: f.artifacts, actor, authorize: () => true, executionBackend: f.backend })
  try { await assert.rejects(coordinator.start({ contract }), { code: 'TASK_WORKSPACE_REQUIRED' }) }
  finally { await coordinator.close(); await kernel.shutdown() }
})

test('contract delegated tools never override an explicit read-only level', async t => {
  const f = await setup(t, { permission: { level: 'readonly', rules: [] } })
  const run = await f.coordinator.start({ contract })
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'write the test file' })
  assert.equal(result.run.actions.length, 0)
  assert.match(result.turn.toolEvents[0].output, /permission denied/)
  await assert.rejects(readFile(path.join(f.cwd, 'created.txt')), { code: 'ENOENT' })
})

test('explicit manual rules require a fresh real host decision despite delegated tool names', async t => {
  const requests = []
  const f = await setup(t, { permission: { level: 'manual', rules: [{ tool: 'write', pattern: '*', action: 'ask' }] }, authorize: request => { requests.push(request); return request.kind === 'run.contract' } })
  const run = await f.coordinator.start({ contract })
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'write the test file' })
  assert.equal(result.run.actions.length, 0)
  assert.ok(requests.some(request => request.kind === 'run.tool'))
  await assert.rejects(readFile(path.join(f.cwd, 'created.txt')), { code: 'ENOENT' })
})

for (const protocol of ['openai', 'anthropic']) test(`lost tool_result is repaired with persisted evidence before a strict ${protocol} HTTP request`, async t => {
  let repairedSeen = false
  const f = await setup(t, { protocol, validateRequest(body) {
    const pending = new Set()
    for (const message of body.messages || []) {
      if (protocol === 'openai') {
        if (pending.size && message.role !== 'tool') throw new Error('tool result must immediately follow its assistant call')
        if (message.role === 'assistant') for (const call of message.tool_calls || []) pending.add(call.id)
        if (message.role === 'tool') {
          if (!pending.delete(message.tool_call_id)) throw new Error('orphan tool result')
          if (String(message.content).includes('Recovered durable tool receipt')) repairedSeen = true
        }
      } else {
        const blocks = Array.isArray(message.content) ? message.content : []
        if (pending.size && !blocks.some(block => block.type === 'tool_result')) throw new Error('missing anthropic tool_result')
        for (const block of blocks) {
          if (block.type === 'tool_use') pending.add(block.id)
          if (block.type === 'tool_result') {
            if (!pending.delete(block.tool_use_id)) throw new Error('orphan anthropic result')
            if (JSON.stringify(block.content).includes('Recovered durable tool receipt')) repairedSeen = true
          }
        }
      }
    }
    if (pending.size) throw new Error('unanswered tool calls')
  } })
  const run = await f.coordinator.start({ contract })
  await f.coordinator.execute({ runId: run.id, prompt: 'create the fixture file' })
  const saved = await getSession(run.binding.sessionId)
  const callIndex = saved.messages.findIndex(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use'))
  assert.ok(callIndex >= 0)
  const originalCall = structuredClone(saved.messages[callIndex])
  // Simulate the persisted boundary after assistant tool_use but before user result.
  await replaceMessages(run.binding.sessionId, saved.messages.slice(0, callIndex + 1))
  await flushNow()
  const resumed = await f.coordinator.resume({ runId: run.id, prompt: 'report existing work, do not repeat the write' })
  assert.equal(resumed.turn.error, null, JSON.stringify(resumed.turn))
  assert.equal(repairedSeen, true)
  assert.equal(resumed.run.actions.length, 1)
  const repaired = await getSession(run.binding.sessionId)
  assert.deepEqual(repaired.messages.find(message => message.id === originalCall.id).content, originalCall.content)
  assert.ok(repaired.messages.some(message => message.recoveredFromRun === run.id))
})

test('pause cancels actual tool, preserves unknown outcome, and requires checked evidence before resume', { timeout: 20_000 }, async t => {
  let effectStarted
  const started = new Promise(resolve => { effectStarted = resolve })
  const backend = {
    allowedToolNames: ['write'], ensureReady: async () => ({ strict: true }),
    async executeTool({ invoke, signal }) {
      await invoke(); effectStarted()
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('fixture cancellation after effect'), { code: 'ABORT_ERR' })), { once: true }))
    }
  }
  const f = await setup(t, { backend })
  const run = await f.coordinator.start({ contract })
  const execution = f.coordinator.execute({ runId: run.id, prompt: 'create file then wait' })
  await Promise.race([started, execution.then(result => { throw new Error(`execution ended before effect: ${JSON.stringify(result.turn)}`) })])
  await f.coordinator.pause({ runId: run.id })
  await execution
  const paused = await f.coordinator.inspect(run.id)
  assert.equal(paused.state, 'outcome_unknown')
  assert.equal(paused.actions[0].state, 'unknown')
  await assert.rejects(f.coordinator.resume({ runId: run.id }), { code: 'UNRESOLVED_ACTIONS' })
  const proof = await f.artifacts.put({ actor: { ...actor, sessionId: run.binding.sessionId, runId: run.id }, content: await readFile(path.join(f.cwd, 'created.txt')), source: { kind: 'system' } })
  await f.coordinator.reconcile({ runId: run.id, actionId: paused.actions[0].id, state: 'succeeded', evidenceRefs: [proof.id] })
  const pausedBudget = await f.store.getRunBudget({ runId: run.id })
  assert.equal(pausedBudget.requests.some(request => request.status !== 'settled'), false, JSON.stringify(pausedBudget))
  const resumed = await f.coordinator.resume({ runId: run.id, prompt: 'report the persisted result, no more tools' })
  assert.equal(resumed.run.state, 'waiting_input')
  assert.equal(resumed.run.actions.length, 1)
})

test('duplicate persisted tool results fail closed before another model request', async t => {
  const f = await setup(t)
  const run = await f.coordinator.start({ contract })
  await f.coordinator.execute({ runId: run.id, prompt: 'create the fixture once' })
  const saved = await getSession(run.binding.sessionId)
  const messages = structuredClone(saved.messages)
  const response = messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))
  response.content.push(structuredClone(response.content.find(block => block.type === 'tool_result')))
  await replaceMessages(run.binding.sessionId, messages); await flushNow()
  const requests = f.requests()
  await assert.rejects(f.coordinator.resume({ runId: run.id, prompt: 'continue' }), { code: 'RECOVERY_HISTORY_UNVERIFIED' })
  assert.equal(f.requests(), requests)
})

test('lost failed response uses explicit host reconciliation rather than fabricating original tool success', async t => {
  let observed = false
  const f = await setup(t, { protocol: 'anthropic', backend: {
    allowedToolNames: ['write'], ensureReady: async () => ({ strict: true }),
    executeTool: async () => { throw toolPreDispatchError(Object.assign(new Error('Host refused before any write'), { code: 'FIXTURE_NOT_STARTED' })) }
  }, validateRequest(body) {
    for (const message of body.messages || []) for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_result' && String(block.content).includes('Host recovery receipt:')) {
        assert.equal(block.is_error, true)
        assert.match(block.content, /state=not_applied/)
        assert.match(block.content, /not a recreated original output/)
        assert.match(block.content, /Evidence: art_/)
        observed = true
      }
    }
  } })
  const run = await f.coordinator.start({ contract })
  const result = await f.coordinator.execute({ runId: run.id, prompt: 'Attempt the governed operation once' })
  assert.equal(result.run.actions[0].state, 'not_applied')
  const saved = await getSession(run.binding.sessionId)
  const call = saved.messages.findIndex(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use'))
  assert.ok(call >= 0)
  await replaceMessages(run.binding.sessionId, saved.messages.slice(0, call + 1)); await flushNow()
  const resumed = await f.coordinator.resume({ runId: run.id, prompt: 'Report why no file was created; do not retry' })
  assert.equal(resumed.turn.error, null, JSON.stringify(resumed.turn)); assert.equal(observed, true)
  assert.equal(resumed.run.actions.length, 1)
  await assert.rejects(readFile(path.join(f.cwd, 'created.txt')), { code: 'ENOENT' })
})

test('external adapter consumes a scoped grant once, rechecks continuation and does not replay', async t => {
  const f = await setup(t, { responses: [finalReply] })
  const run = await f.coordinator.start({ contract })
  await f.coordinator.execute({ runId: run.id, prompt: 'prepare only' })
  const adapter = f.coordinator.actionAdapter(run.id)
  const action = { id: 'comment-1', kind: 'forge.comment', target: 'https://example.invalid/repository#task', parameterHash: hash('comment'), effect: 'external_write', retryPolicy: 'reconcile' }
  assert.equal(await adapter.lookup(action), null)
  await assert.rejects(adapter.prepare(action), { code: 'APPROVAL_REQUIRED' })
  assert.equal(await adapter.authorize(action), true)
  assert.equal((await adapter.prepare(action)).fresh, true)
  await assert.rejects(adapter.lookup(action), { code: 'ACTION_STILL_RUNNING' })
  assert.equal(await adapter.authorize(action), true)
  await adapter.settle({ id: action.id, state: 'succeeded', receipt: { summary: 'read-only remote proof', evidenceRefs: ['forge:fixture:comment:1:sha'] } })
  const replay = await adapter.prepare(action)
  assert.equal(replay.fresh, false)
  assert.equal(replay.state, 'succeeded')
  assert.equal((await adapter.lookup(action)).state, 'succeeded')
  await assert.rejects(adapter.lookup({ ...action, parameterHash: hash('different comment') }), { code: 'ACTION_CONFLICT' })
  assert.equal((await f.coordinator.inspect(run.id)).state, 'waiting_input')
})

test('another host requests cancellation without stealing a live execution lease', { timeout: 20_000 }, async t => {
  let effectStarted
  const started = new Promise(resolve => { effectStarted = resolve })
  const f = await setup(t, { backend: {
    allowedToolNames: ['write'], ensureReady: async () => ({ strict: true }),
    async executeTool({ invoke, signal }) {
      await invoke(); effectStarted()
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel after effect'), { code: 'ABORT_ERR' })), { once: true }))
    }
  } })
  const run = await f.coordinator.start({ contract })
  const execution = f.coordinator.execute({ runId: run.id, prompt: 'create and wait for another host' })
  await Promise.race([started, execution.then(() => { throw new Error('turn ended before effect') })])
  const kernel = await createDelegatedKernel({ cwd: f.cwd, configState: config(f.baseUrl), trustState: { trusted: true } })
  const controller = createRunCoordinator({ kernel, store: f.store, artifacts: f.artifacts, actor, ownerId: 'second-host', authorize: () => true, executionBackend: f.backend, leaseDirectory: path.join(f.root, 'leases'), grantDirectory: path.join(f.root, 'grants') })
  try {
    await assert.rejects(controller.attach({ runId: run.id }), { code: 'device_in_use' })
    const before = await controller.inspect(run.id)
    await assert.rejects(controller.cancel({ runId: run.id, expectedRevision: before.revision - 1, expectedOwnerEpoch: before.ownerEpoch }), { code: 'REVISION_CONFLICT' })
    await controller.cancel({ runId: run.id, expectedRevision: before.revision, expectedOwnerEpoch: before.ownerEpoch })
    const outcome = await execution
    assert.equal(outcome.run.state, 'cancelled')
    assert.equal(outcome.run.ownerId, 'fixture-host')
    assert.equal(outcome.run.ownerEpoch, 1)
    assert.equal(outcome.run.actions[0].state, 'unknown')
    assert.equal(await hasUnresolvedSessionRun(run.binding.sessionId, { store: f.store }), true)
    assert.ok((await f.store.events({ runId: run.id })).some(event => event.type === 'control.requested'))
  } finally { await controller.close(); await kernel.shutdown() }
})

test('killed real coordinator host leaves durable effect intent and fenced recovery', { timeout: 30_000 }, async t => {
  const f = await setup(t)
  const worker = fork(fileURLToPath(new URL('./fixtures/run-coordinator-crash-worker.mjs', import.meta.url)), [f.root, f.cwd, f.baseUrl], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, KKCODE_HOME: path.join(f.root, 'private') } })
  let stderr = ''
  worker.stderr.on('data', data => { stderr += data.toString() })
  t.after(() => { if (worker.exitCode === null) worker.kill('SIGKILL') })
  const message = await Promise.race([once(worker, 'message').then(([message]) => message), once(worker, 'exit').then(() => { throw new Error(`worker exited before effect: ${stderr}`) })])
  assert.equal(message.effectApplied, true)
  const killed = once(worker, 'exit')
  assert.equal(worker.kill('SIGKILL'), true)
  const [, signal] = await killed
  assert.equal(signal, 'SIGKILL', 'the recovery test must observe a real forced crash, not natural exit')
  let run = await f.store.getRun(message.runId)
  assert.equal(run.actions[0].state, 'prepared')
  assert.equal(run.lastTurn.status, 'running')
  run = await f.coordinator.attach({ runId: run.id })
  assert.equal(run.state, 'outcome_unknown')
  assert.equal(run.lastTurn.status, 'interrupted')
  assert.equal(run.ownerEpoch, 2)
  await assert.rejects(f.coordinator.resume({ runId: run.id }), { code: 'UNRESOLVED_ACTIONS' })
  assert.match(await readFile(path.join(f.cwd, 'created.txt'), 'utf8'), /actual tool/)
  const proof = await f.artifacts.put({ actor: { ...actor, sessionId: run.binding.sessionId, runId: run.id }, content: 'Host inspected the file after SIGKILL; it contains the intended content', source: { kind: 'system' } })
  await f.coordinator.reconcile({ runId: run.id, actionId: run.actions[0].id, state: 'succeeded', evidenceRefs: [proof.id] })
  const resumed = await f.coordinator.resume({ runId: run.id, prompt: 'Only report the existing result' })
  assert.equal(resumed.run.state, 'waiting_input')
  assert.equal(resumed.run.actions.length, 1)
})
