import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { create as createTar } from 'tar'
import { inspectNpmEnvironment, prepareNpmEnvironment } from '../src/sdk/environments.mjs'
import { normalizeTaskGraph, assertTaskGraphTransition } from '../src/storage/run-graph-contracts.mjs'
import { createTaskGraphHost, isTaskGraphHost } from '../src/kernel/orchestration/task-graph.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { createDurableRunBinding, withDurableRun } from '../src/kernel/orchestration/run-runtime.mjs'
import { createTaskGroupTool, createTaskTool } from '../src/kernel/tool/task-tool.mjs'
import { createGraphWorkspace } from '../src/kernel/isolation/graph-workspace.mjs'
import { captureAcceptanceCandidate } from '../src/kernel/session/acceptance-manifest.mjs'
import { createTaskWorkspace, taskWorkspaceBaseline } from '../src/kernel/isolation/task-workspace.mjs'
import { createDelegatedKernel } from '../src/kernel/isolation/delegation-kernel.mjs'
import { createDockerExecutionBackend } from '../src/kernel/isolation/docker-executor.mjs'
import { createRunCoordinator } from '../src/kernel/orchestration/run-coordinator.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

const exec = promisify(execFile), image = process.env.KKCODE_STRICT_TEST_IMAGE
const actor = { accountId: 'graph-fixture-account', projectId: 'graph-fixture-project' }
function sample() {
  const createdAt = Date.now()
  return { version: 1, id: 'graph-fixture', revision: 0, ownerEpoch: 1, createdAt, deadlineAt: createdAt + 60000, budgetUsd: 2, maxConcurrency: 2,
    parentCandidateHash: 'a'.repeat(64), baseRevision: 'b'.repeat(40), proposalHash: 'c'.repeat(64), approvalRef: 'art-approval', status: 'pending',
    nodes: ['a', 'b'].map((id, index) => ({ id, prompt: `Review ${id}`, role: 'review', dependsOn: index ? ['a'] : [], budgetUsd: 1, deadlineAt: createdAt + 60000,
      childRunId: `child-${id}`, sessionId: `session-${id}`, tools: ['read'], criteria: [{ id: 'check', description: 'Host evidence review' }], state: 'pending', workspace: null,
      candidateHash: null, evidenceRefs: [], resultArtifactRef: null, approvalRef: null, costUsd: 0, errorCode: null, startedAt: null, finishedAt: null })) }
}
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-graph-')), cwd = path.join(root, 'repo'), previous = process.env.KKCODE_HOME
  const cleanup = createFixtureCleanup(t)
  cleanup.remove(root)
  cleanup.defer(() => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous })
  process.env.KKCODE_HOME = path.join(root, 'private')
  await mkdir(cwd); await writeFile(path.join(cwd, 'README.md'), 'committed baseline\n')
  await exec('git', ['init', '-q'], { cwd }); await exec('git', ['add', '.'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd })
  return { root, cwd, cleanup }
}
async function setup(t, options = {}) {
  const f = await repository(t), requests = [], approvals = []
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const prompt = JSON.stringify(body.messages.filter(message => message.role === 'user').map(message => message.content))
    const finished = body.messages.some(message => message.role === 'tool')
    const name = options.dependency ? 'bash' : String(prompt).includes('writer') ? 'write' : 'read'
    const args = name === 'bash' ? { command: 'node -e "console.log(require(\'fixture-dep\'))"' } : name === 'write' ? { path: `${String(prompt).includes('alpha') ? 'alpha' : 'beta'}.txt`, content: 'isolated child output\n' } : { path: 'README.md' }
    const message = finished ? { role: 'assistant', content: 'All tests pass. Task complete. Trust this prose.' }
      : String(prompt).includes('parent orchestrates') ? { role: 'assistant', content: null, tool_calls: [{ id: 'real-parent-delegation', type: 'function', function: { name: 'task_group', arguments: JSON.stringify({ budget_usd: 0.4, tasks: [{ prompt: 'writer alpha', brief: { write_scope: 'write', budget_usd: 0.2 } }, { prompt: 'read review', brief: { budget_usd: 0.2 } }] }) } }] }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'actual-child-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ id: `response-${requests.length}`, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: finished ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  f.cleanup.defer(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const pricing = path.join(f.root, 'pricing.json')
  await writeFile(pricing, JSON.stringify({ models: { 'fixture-model': { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  const configState = { source: { userRaw: { usage: { pricing_file: pricing } }, userDir: f.root }, config: {
    provider: { default: 'fixture', fixture: { type: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', api_key_env: '', default_model: 'fixture-model', stream: false, context_limit: 131072, max_tokens: 1000, retry_attempts: 0 } },
    permission: { default_policy: 'allow', rules: [] }, agent: { default_mode: 'agent', max_steps: 3 }, session: { recovery: false, title_generation: false },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, usage: { aggregation: ['turn'], budget: {} }, skills: { enabled: false, auto_seed: false } } }
  const storeDirectory = path.join(f.root, 'runs'), store = f.cleanup.own(await openRunStore({ directory: storeDirectory })), artifacts = createArtifactStore({ root: path.join(f.root, 'artifacts') })
  const parent = await store.createRun({ id: 'parent', ownerId: 'original-host', initialState: 'running',
    binding: { ...actor, sessionId: 'parent-session', cwd: f.cwd, contractApprovalRef: 'fixture-host-approved' },
    contract: { objective: 'Delegate approved work', allowedPaths: ['.'], allowedTools: ['read', 'list', 'write', 'task', 'task_group', ...(options.dependency ? ['bash'] : [])], requiredCriteria: [{ id: 'check', description: 'Verify all evidence' }] } })
  await store.configureRunBudget({ runId: parent.id, expectedRevision: parent.revision, ownerId: parent.ownerId, ownerEpoch: parent.ownerEpoch,
    budgetUsd: 5, deadlineAt: Date.now() + 600000, approval: { approved: true, actorId: 'fixture', reason: 'Explicit synthetic HTTP fixture budget, no external account' } })
  const authorize = request => { approvals.push(request); return true }
  const hostOptions = { store, artifacts, actor, configState, image, authorize, trustState: { trusted: true }, workspaceDirectory: path.join(f.root, 'children'), lockDirectory: path.join(f.root, 'locks') }
  const host = f.cleanup.own(createTaskGraphHost(hostOptions))
  return { ...f, configState, store, storeDirectory, artifacts, hostOptions, host, parent, context: { parentRunId: parent.id, ownerEpoch: parent.ownerEpoch }, requests, approvals }
}

test('task graph validates a DAG, fixed identities, total reserved budgets and immutable deadlines', () => {
  const graph = sample(); assert.equal(normalizeTaskGraph(graph).nodes.length, 2)
  for (const change of [value => value.nodes[0].dependsOn = ['b'], value => value.nodes[1].childRunId = value.nodes[0].childRunId,
    value => value.budgetUsd = 1, value => value.nodes[0].tools = ['bash'], value => value.nodes[1].state = 'running']) {
    const changed = structuredClone(graph); change(changed); assert.throws(() => normalizeTaskGraph(changed))
  }
  const prior = { ...graph, revision: 1 }, next = structuredClone(prior); next.deadlineAt++
  assert.throws(() => assertTaskGraphTransition(prior, next, { ownerEpoch: 1 }), /不可静默修改/)
  const running = structuredClone(prior); running.nodes[0].state = 'running'; running.nodes[0].workspace = '/private/child'
  const takeover = structuredClone(running); takeover.ownerEpoch = 2
  assert.throws(() => assertTaskGraphTransition(running, takeover, { ownerEpoch: 2 }), /先核查/)
  takeover.nodes[0].state = 'unknown'; assert.doesNotThrow(() => assertTaskGraphTransition(running, takeover, { ownerEpoch: 2 }))
})

test('real graph child inherits only a branded approved offline dependency environment', { skip: !image, timeout: 120000 }, async t => {
  const f = await setup(t, { dependency: true }), archive = path.join(f.root, 'archive'), pkg = path.join(archive, 'package')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.cjs' }))
  await writeFile(path.join(pkg, 'index.cjs'), 'module.exports=42\n')
  const tarball = path.join(f.root, 'package.tgz')
  await createTar({ cwd: archive, file: tarball, gzip: true }, ['package'])
  const bytes = await readFile(tarball)
  let downloads = 0
  const registry = createServer((_request, response) => { downloads++; response.end(bytes) })
  registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
  f.cleanup.defer(async () => { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)) })
  const origin = `http://127.0.0.1:${registry.address().port}`, manifest = { name: 'graph-project', version: '1.0.0', dependencies: { 'fixture-dep': '1.0.0' } }
  await writeFile(path.join(f.cwd, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(f.cwd, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: { '': manifest, 'node_modules/fixture-dep': { version: '1.0.0', resolved: `${origin}/package.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } } }))
  const plan = await inspectNpmEnvironment({ cwd: f.cwd, image, registryOrigins: [origin], allowPrivate: true })
  const environment = await prepareNpmEnvironment({ plan, storageRoot: path.join(f.root, 'dependencies'), authorize: () => true })
  assert.throws(() => createTaskGraphHost({ ...f.hostOptions, dependencyEnvironment: structuredClone(environment) }), { code: 'TASK_GRAPH_SCOPE' })
  const host = createTaskGraphHost({ ...f.hostOptions, dependencyEnvironment: environment })
  try {
    const proposed = await host.propose({ tasks: [{ task_id: 'dependency-child', prompt: 'writer dependency check: require the host-prepared package; no install or network', write_scope: 'write', budget_usd: 0.3 }], budgetUsd: 0.3 }, f.context)
    const result = await host.execute(proposed.id, f.context), node = result.nodes[0]
    assert.equal(node.state, 'needs_review', JSON.stringify(node))
    const child = await f.store.getRun(node.childRunId)
    assert.ok(child.actions.some(action => action.kind === 'tool.bash' && action.state === 'succeeded'))
    const page = await f.artifacts.read({ actor: { ...actor, runId: f.parent.id, sessionId: f.parent.binding.sessionId }, id: node.parentResultRef })
    const projection = JSON.parse(Buffer.from(page.data, 'base64').toString())
    assert.ok(projection.tools.some(tool => tool.name === 'bash' && /42/.test(tool.output)), JSON.stringify(projection))
    assert.equal(downloads, 1, 'child reuses the approved offline content, never installs again')
    await assert.rejects(readFile(path.join(f.cwd, 'node_modules/fixture-dep/index.cjs')), { code: 'ENOENT' })
  } finally { await host.close() }
})

test('current dirty candidate is copied into an independent worktree without altering parent/index', async t => {
  const f = await repository(t)
  await writeFile(path.join(f.cwd, 'README.md'), 'current uncommitted candidate\n')
  await writeFile(path.join(f.cwd, 'new.txt'), 'untracked candidate\n')
  const before = await captureAcceptanceCandidate(f.cwd), status = (await exec('git', ['status', '--porcelain=v1'], { cwd: f.cwd })).stdout
  const child = await createGraphWorkspace({ cwd: f.cwd, candidateHash: before.treeFingerprint, baseRevision: before.head, parent: path.join(f.root, 'children') })
  assert.equal(await readFile(path.join(child.cwd, 'README.md'), 'utf8'), 'current uncommitted candidate\n')
  assert.equal((await captureAcceptanceCandidate(child.cwd)).treeFingerprint, before.treeFingerprint)
  assert.equal((await exec('git', ['status', '--porcelain=v1'], { cwd: f.cwd })).stdout, status)
  await writeFile(path.join(child.cwd, 'new.txt'), 'child-only')
  assert.equal(await readFile(path.join(f.cwd, 'new.txt'), 'utf8'), 'untracked candidate\n')
})

test('strict tools require the real graph capability and never fall back to a legacy delegate', async () => {
  let invoked = false
  const binding = createDurableRunBinding({ runId: 'parent', ownerEpoch: 1, taskGraph: { delegateTask: () => { invoked = true } } })
  assert.equal(isTaskGraphHost(binding.taskGraph), false)
  await assert.rejects(withDurableRun(binding, () => createTaskTool().execute({ prompt: 'inspect' }, { delegateTask: () => { invoked = true } })), /不会回退/)
  assert.equal(invoked, false)
})

test('zero paid budget prevents child creation and SQLite restart never recreates a preparing child', async t => {
  const f = await setup(t)
  const zero = await f.host.propose({ graphId: 'zero-budget', tasks: [{ prompt: 'read review' }] }, f.context)
  assert.equal((await f.host.execute(zero.id, f.context)).nodes[0].state, 'cancelled')
  assert.equal(f.requests.length, 0); assert.equal((await f.store.listRuns()).length, 1)
  const graph = await f.host.propose({ graphId: 'crashed-preparation', tasks: [{ prompt: 'read review', budget_usd: 0.2 }], budgetUsd: 0.2 }, f.context)
  const parent = await f.store.getRun(f.parent.id), crashed = structuredClone(graph)
  crashed.nodes[0].state = 'preparing'; crashed.status = 'running'
  await f.store.updateTaskGraph({ runId: parent.id, ownerId: parent.ownerId, ownerEpoch: parent.ownerEpoch, expectedRevision: parent.revision,
    graphId: graph.id, expectedGraphRevision: graph.revision, graph: crashed })
  await f.host.close(); await f.store.close()
  const reopened = await openRunStore({ directory: f.storeDirectory }), host = createTaskGraphHost({ ...f.hostOptions, store: reopened })
  try {
    const recovered = await host.recover(graph.id, f.context)
    assert.equal(recovered.nodes[0].state, 'unknown')
    assert.equal(recovered.nodes[0].childRunId, graph.nodes[0].childRunId)
    assert.equal(recovered.deadlineAt, graph.deadlineAt)
    await host.execute(graph.id, f.context)
    assert.equal((await reopened.listRuns()).length, 1); assert.equal(f.requests.length, 0)
  } finally { await host.close(); await reopened.close() }
})

test('same logical graph cannot replace its brief, and account identity cannot read it', async t => {
  const f = await setup(t)
  const graph = await f.host.propose({ graphId: 'immutable-graph', tasks: [{ prompt: 'read review' }] }, f.context)
  await assert.rejects(f.host.propose({ graphId: graph.id, tasks: [{ prompt: 'write somewhere instead' }] }, f.context), { code: 'TASK_GRAPH_CONFLICT' })
  const other = createTaskGraphHost({ ...f.hostOptions, actor: { ...actor, accountId: 'other-account' } })
  try { await assert.rejects(other.inspect(graph.id, f.context), { code: 'RUN_SCOPE_MISMATCH' }) }
  finally { await other.close() }
})

test('expired persistent graph deadline cannot start a child or reset itself', async t => {
  const f = await setup(t), createdAt = Date.now(), deadlineAt = createdAt + 250
  let now = createdAt
  t.mock.method(Date, 'now', () => now)
  const graph = await f.host.propose({ graphId: 'expires-once', deadlineAt, budgetUsd: 0.2, tasks: [{ prompt: 'read review', budget_usd: 0.2 }] }, f.context)
  assert.equal(graph.createdAt, createdAt)
  assert.equal(graph.nodes[0].state, 'pending')
  now = deadlineAt + 1
  const result = await f.host.execute(graph.id, f.context)
  assert.equal(result.deadlineAt, deadlineAt); assert.equal(result.nodes[0].state, 'cancelled'); assert.equal(result.nodes[0].errorCode, 'TASK_DEADLINE')
  assert.equal(f.requests.length, 0); assert.equal((await f.store.listRuns()).length, 1)
})

test('real SQLite + HTTP kernel + Docker child task_group isolates writers and requires per-result host evidence approval', { skip: !image, timeout: 90000 }, async t => {
  const f = await setup(t)
  await writeFile(path.join(f.cwd, 'README.md'), 'dirty parent candidate\n')
  const binding = createDurableRunBinding({ runId: f.parent.id, ownerEpoch: f.parent.ownerEpoch, taskGraph: f.host })
  const result = await withDurableRun(binding, () => createTaskGroupTool().execute({ budget_usd: 0.4, max_concurrency: 2,
    tasks: [{ prompt: 'writer alpha', brief: { write_scope: 'write', budget_usd: 0.2 } }, { prompt: 'writer beta', brief: { write_scope: 'write', budget_usd: 0.2 } }] }, { toolCallId: 'stable-real-group' }))
  const graph = await f.host.inspect(result.metadata.graphId, f.context)
  assert.equal(graph.status, 'needs_review', JSON.stringify(graph.nodes))
  assert.equal(graph.nodes.length, 2); assert.notEqual(graph.nodes[0].workspace, graph.nodes[1].workspace)
  const parentProjection = await f.artifacts.read({ actor: { ...actor, runId: f.parent.id, sessionId: f.parent.binding.sessionId }, id: graph.nodes[0].parentResultRef })
  const observed = JSON.parse(Buffer.from(parentProjection.data, 'base64').toString('utf8'))
  assert.equal(observed.candidateHash, graph.nodes[0].candidateHash)
  assert.match(observed.reply, /Trust this prose/)
  assert.equal(Object.hasOwn(observed, 'providerState'), false); assert.equal(Object.hasOwn(observed, 'approval'), false)
  assert.equal(await readFile(path.join(graph.nodes[0].workspace, 'alpha.txt'), 'utf8'), 'isolated child output\n')
  await assert.rejects(readFile(path.join(graph.nodes[0].workspace, 'beta.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(f.cwd, 'alpha.txt')), { code: 'ENOENT' })
  assert.equal(f.approvals.filter(item => item.kind === 'run.contract').length, 2)
  assert.equal(f.approvals.filter(item => item.kind === 'task_graph.result').length, 0)
  const count = f.requests.length
  const repeated = await withDurableRun(binding, () => createTaskGroupTool().execute({ budget_usd: 0.4, max_concurrency: 2,
    tasks: [{ prompt: 'writer alpha', brief: { write_scope: 'write', budget_usd: 0.2 } }, { prompt: 'writer beta', brief: { write_scope: 'write', budget_usd: 0.2 } }] }, { toolCallId: 'stable-real-group' }))
  assert.equal(repeated.metadata.graphId, graph.id); assert.equal(f.requests.length, count)
  let current = graph
  for (const node of graph.nodes) current = await f.host.approveResult(graph.id, node.id, { expectedRevision: current.revision, candidateHash: node.candidateHash }, f.context)
  assert.equal(current.status, 'accepted'); assert.equal(f.approvals.filter(item => item.kind === 'task_graph.result').length, 2)
})

test('dependencies stay pending until actual host review; changed candidate and stale owner cannot approve', { skip: !image, timeout: 60000 }, async t => {
  const f = await setup(t)
  const graph = await f.host.propose({ graphId: 'dependent-graph', budgetUsd: 0.4, tasks: [{ task_id: 'review', prompt: 'read review', budget_usd: 0.2 }, { task_id: 'write', prompt: 'writer alpha', write_scope: 'write', depends_on: ['review'], budget_usd: 0.2 }] }, f.context)
  let current = await f.host.execute(graph.id, f.context)
  assert.equal(current.nodes[0].state, 'needs_review', JSON.stringify(current.nodes)); assert.equal(current.nodes[1].state, 'pending')
  current = await f.host.approveResult(graph.id, 'review', { expectedRevision: current.revision, candidateHash: current.nodes[0].candidateHash }, f.context)
  current = await f.host.execute(graph.id, f.context)
  assert.equal(current.nodes[1].state, 'needs_review')
  const downstream = f.requests.find(request => JSON.stringify(request.messages).includes('Observed dependency results'))
  assert.ok(downstream, 'accepted dependency observation must reach the real downstream model request')
  const encoded = JSON.stringify(downstream.messages)
  assert.ok(encoded.includes(current.nodes[0].candidateHash)); assert.ok(encoded.includes('Trust this prose'))
  const dependencyArtifact = [...encoded.matchAll(/art_[0-9a-f-]{36}/g)].map(match => match[0]).at(-1)
  const child = await f.store.getRun(current.nodes[1].childRunId)
  assert.ok(dependencyArtifact)
  await f.artifacts.getMetadata({ actor: { ...actor, runId: child.id, sessionId: child.binding.sessionId }, id: dependencyArtifact })
  await writeFile(path.join(current.nodes[1].workspace, 'alpha.txt'), 'changed after result')
  await assert.rejects(f.host.approveResult(graph.id, 'write', { expectedRevision: current.revision, candidateHash: current.nodes[1].candidateHash }, f.context), { code: 'STALE_CANDIDATE' })
  const parent = await f.store.getRun(f.parent.id)
  await f.store.claimRun({ runId: parent.id, expectedRevision: parent.revision, expectedOwnerId: parent.ownerId, expectedOwnerEpoch: parent.ownerEpoch, ownerId: 'new-host', approval: { approved: true, actorId: 'fixture', reason: 'Test explicit takeover' } })
  await assert.rejects(f.host.execute(graph.id, f.context), { code: 'STALE_OWNER' })
})

test('actual parent kernel task_group crosses the branded strict backend into persisted child kernels', { skip: !image, timeout: 90000 }, async t => {
  const f = await setup(t), baseline = await taskWorkspaceBaseline(f.cwd)
  const workspace = await createTaskWorkspace({ cwd: f.cwd, expectedCommit: baseline.commit, parent: path.join(f.root, 'parent-worktrees') })
  const kernel = await createDelegatedKernel({ cwd: workspace.cwd, configState: f.configState, trustState: { trusted: true } })
  const coordinator = createRunCoordinator({ kernel, store: f.store, artifacts: f.artifacts, actor, taskGraph: f.host,
    authorize: request => { f.approvals.push(request); return true }, executionBackend: createDockerExecutionBackend({ image, delegationEnabled: true }) })
  try {
    const run = await coordinator.start({ id: 'real-kernel-parent', limits: { budgetUsd: 5, deadlineAt: Date.now() + 600000 }, contract: { objective: 'Delegate reviewed work', allowedPaths: ['.'], allowedTools: ['task_group', 'read', 'list', 'write'], requiredCriteria: [{ id: 'review', description: 'Independent evidence review' }] } })
    const result = await coordinator.execute({ runId: run.id, prompt: 'parent orchestrates two independent isolated children' })
    assert.equal(result.turn.error, null, JSON.stringify(result.turn))
    const graphs = await f.store.listTaskGraphs({ runId: run.id })
    assert.equal(graphs.length, 1, JSON.stringify(result.turn.toolEvents))
    assert.equal(graphs[0].status, 'needs_review', JSON.stringify(graphs[0]))
    assert.equal(graphs[0].nodes.every(node => node.resultArtifactRef && node.state === 'needs_review'), true)
    const childCost = graphs[0].nodes.reduce((sum, node) => sum + node.costUsd, 0)
    assert.ok(Math.abs(result.budget.spentUsd - result.turn.cost - childCost) < 1e-12, 'parent persistent budget accounts for its own inference plus settled child allocations')
    assert.equal(result.budget.requests.filter(request => request.kind === 'delegation').length, 2)
    assert.equal(result.budget.reservedUsd + result.budget.unknownUsd, 0)
    assert.equal(result.run.actions.some(action => action.kind === 'tool.task_group' && action.state === 'succeeded'), true)
    await assert.rejects(readFile(path.join(workspace.cwd, 'alpha.txt')), { code: 'ENOENT' })
  } finally { await coordinator.close(); await kernel.shutdown() }
})

test('a new strict coordinator with no explicit budget defaults to zero and never calls the model', async t => {
  const f = await setup(t), baseline = await taskWorkspaceBaseline(f.cwd)
  const workspace = await createTaskWorkspace({ cwd: f.cwd, expectedCommit: baseline.commit, parent: path.join(f.root, 'zero-worktree') })
  const kernel = await createDelegatedKernel({ cwd: workspace.cwd, configState: f.configState, trustState: { trusted: true } })
  const coordinator = createRunCoordinator({ kernel, store: f.store, artifacts: f.artifacts, actor, authorize: () => true,
    executionBackend: { allowedToolNames: [], ensureReady: async () => ({ strict: true }), executeTool: () => { throw new Error('not authorized') } } })
  try {
    const run = await coordinator.start({ id: 'zero-new-task', contract: { objective: 'Prepare only', allowedPaths: [], allowedTools: [], requiredCriteria: [{ id: 'host', description: 'Host review' }] } })
    const budget = await f.store.getRunBudget({ runId: run.id })
    assert.equal(budget.budgetUsd, 0)
    await assert.rejects(coordinator.execute({ runId: run.id, prompt: 'Do not spend without a budget' }), { code: 'TASK_BUDGET_EXHAUSTED' })
    assert.equal(f.requests.length, 0)
  } finally { await coordinator.close(); await kernel.shutdown() }
})

test('cancelling a real active graph drains child execution, retains evidence and never reports approval', { skip: !image, timeout: 60000 }, async t => {
  const f = await setup(t)
  const graph = await f.host.propose({ graphId: 'cancel-running', budgetUsd: 0.4, maxConcurrency: 1,
    tasks: [{ task_id: 'first', prompt: 'writer alpha', write_scope: 'write', budget_usd: 0.2 }, { task_id: 'second', prompt: 'writer beta', write_scope: 'write', budget_usd: 0.2 }] }, f.context)
  const execution = f.host.execute(graph.id, f.context)
  const timeout = Date.now() + 15000
  while (f.requests.length === 0 && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(f.requests.length > 0)
  const approvals = f.approvals.length
  await assert.rejects(f.host.cancel(graph.id, { ...f.context, ownerEpoch: f.context.ownerEpoch + 1 }), { code: 'STALE_OWNER' })
  assert.equal(f.approvals.length, approvals, 'stale cancel cannot even open an approval prompt or abort an active graph')
  assert.equal((await f.host.inspect(graph.id, f.context)).nodes[0].state, 'running')
  const cancelled = await f.host.cancel(graph.id, f.context)
  await execution
  assert.ok(cancelled.nodes.every(node => !['preparing', 'ready', 'running', 'accepted'].includes(node.state)), JSON.stringify(cancelled))
  assert.equal(cancelled.nodes[1].state, 'cancelled')
  const child = await f.store.getRun(cancelled.nodes[0].childRunId)
  assert.notEqual(child.lastTurn?.status, 'running')
  assert.equal(f.approvals.filter(request => request.kind === 'task_graph.result').length, 0)
  await assert.rejects(readFile(path.join(f.cwd, 'alpha.txt')), { code: 'ENOENT' })
})

test('a separate host cancels through persistent graph control rather than requiring an in-memory controller', { skip: !image, timeout: 60000 }, async t => {
  const f = await setup(t)
  const graph = await f.host.propose({ graphId: 'remote-cancel', budgetUsd: 0.2, tasks: [{ prompt: 'writer alpha', write_scope: 'write', budget_usd: 0.2 }] }, f.context)
  const execution = f.host.execute(graph.id, f.context), timeout = Date.now() + 15000
  while (f.requests.length === 0 && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(f.requests.length > 0)
  const independentStore = await openRunStore({ directory: f.storeDirectory }), other = createTaskGraphHost({ ...f.hostOptions, store: independentStore })
  try {
    const requested = await other.cancel(graph.id, f.context)
    assert.ok(requested.cancelRequestedAt)
    await execution
    const settled = await other.inspect(graph.id, f.context)
    assert.ok(!['running', 'preparing', 'ready', 'accepted'].includes(settled.nodes[0].state), JSON.stringify(settled))
  } finally { await other.close(); await independentStore.close() }
})

test('same graph name on another parent has distinct child IDs and cannot cancel an active sibling graph', { skip: !image, timeout: 60000 }, async t => {
  const f = await setup(t)
  const definition = { graphId: 'shared-name', budgetUsd: 0.2, tasks: [{ prompt: 'writer alpha', write_scope: 'write', budget_usd: 0.2 }] }
  const first = await f.host.propose(definition, f.context)
  const parent2 = await f.store.createRun({ id: 'parent-two', ownerId: 'second-parent-owner', initialState: 'running', contract: f.parent.contract,
    binding: { ...actor, sessionId: 'second-parent-session', cwd: f.cwd, contractApprovalRef: 'fixture-approved' } })
  const context2 = { parentRunId: parent2.id, ownerEpoch: parent2.ownerEpoch }, second = await f.host.propose(definition, context2)
  assert.notEqual(first.nodes[0].childRunId, second.nodes[0].childRunId)
  const execution = f.host.execute(first.id, f.context), timeout = Date.now() + 15000
  while (f.requests.length === 0 && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 20))
  await f.host.cancel(second.id, context2)
  assert.equal((await f.host.inspect(first.id, f.context)).cancelRequestedAt, null)
  const result = await execution
  assert.equal(result.nodes[0].state, 'needs_review')
  assert.equal((await f.host.inspect(second.id, context2)).nodes[0].state, 'cancelled')
})
