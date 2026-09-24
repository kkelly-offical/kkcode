import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createKernel } from '../src/kernel/index.mjs'
import { createRunSpec } from '../src/kernel/orchestration/run-spec.mjs'
import { createDurableRunBinding, withDurableRun } from '../src/kernel/orchestration/run-runtime.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createDockerExecutionBackend } from '../src/kernel/isolation/docker-executor.mjs'

async function fixture(t, code, handlers = {}, observeRequest = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-tool-program-loop-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true }, handlers })
  const config = kernel.configState.config
  Object.assign(config, { skills: { enabled: false, auto_seed: false }, mcp: { auto_discover: false }, git_auto: { enabled: false, auto_snapshot: false } })
  config.provider = { default: 'program_fixture', program_fixture: { default_model: 'test', stream: false, retry_attempts: 0 } }
  config.agent.max_steps = 5; config.agent.verify_completion = false; config.session.title_generation = false
  config.tool.sources = { builtin: true, local: false, plugin: false, mcp: false }
  config.tool.program = { enabled: true }
  config.permission = { level: 'accept-edits', rules: [] }
  let turn = 0
  kernel.providers.registerProvider('program_fixture', { async request(input) {
    observeRequest?.(input)
    turn++
    return { text: turn > 1 ? 'Inspected the exact partial program outcome.' : '',
      toolCalls: turn === 1 ? [{ id: 'program-parent', name: 'tool_program', args: { code } }] : [],
      usage: {}, stopReason: turn === 1 ? 'tool_use' : 'end_turn' }
  }, async *requestStream() { throw new Error('not streaming') } })
  t.after(async () => { await kernel.shutdown(); if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  const execute = options => kernel.executeTurn({ sessionId: 'program', prompt: 'Execute the scoped operations', providerType: 'program_fixture', model: 'test', ...options })
  return { root, kernel, execute }
}

test('real model loop program keeps earlier writes and stops on an independently denied leaf', async t => {
  let approvals = 0
  const f = await fixture(t, `
    const first = await tools.call("write", {path:"first.txt",content:"retained"});
    if(first.status === "completed") await tools.call("bash", {command:"node -e \\\"process.stdout.write(1)\\\""});
    await tools.call("write", {path:"last.txt",content:"must not run"});
  `, { onPermissionPrompt: () => { approvals++; return 'deny' } })
  const result = await f.execute()
  assert.equal(await readFile(path.join(f.root, 'first.txt'), 'utf8'), 'retained')
  await assert.rejects(readFile(path.join(f.root, 'last.txt')), { code: 'ENOENT' })
  assert.equal(approvals, 1)
  assert.ok(result.toolEvents.some(event => event.output.includes('后续组合已停止')))
})

test('program does not widen agent allowlist or delegated read-only write scope', async t => {
  for (const restriction of ['allowlist', 'write_scope']) {
    await t.test(restriction, async sub => {
      const f = await fixture(sub, 'await tools.call("write",{path:"denied.txt",content:"no"});')
      const runSpec = createRunSpec({ sessionId: 'program', model: 'test', provider: 'program_fixture',
        role: { name: 'scoped-reader', tools: restriction === 'allowlist' ? ['tool_program', 'read'] : ['tool_program', 'read', 'write'] },
        workspace: { root: f.root, cwd: f.root, writeScope: restriction === 'write_scope' ? 'read-only' : null } })
      await f.execute({ runSpec })
      await assert.rejects(readFile(path.join(f.root, 'denied.txt')), { code: 'ENOENT' })
    })
  }
})

test('each real program leaf gets its own stable durable intent and settled record', async t => {
  const f = await fixture(t, 'await tools.call("write",{path:"a.txt",content:"a"}); await tools.call("write",{path:"b.txt",content:"b"}); return "both";')
  const store = await openRunStore({ directory: path.join(f.root, 'run-store') })
  t.after(() => store.close())
  let run = await store.createRun({ id: 'run-program', ownerId: 'host', contract: { objective: 'Create two files', requiredCriteria: [] } })
  const guard = () => ({ runId: run.id, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch, expectedRevision: run.revision })
  const binding = createDurableRunBinding({
    async prepareTool({ tool, args, invocationId, capability }) {
      run = await store.prepareAction({ ...guard(), action: { id: invocationId, kind: tool.name, target: args.path || 'composition',
        parameterHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), effect: capability === 'read' ? 'read' : 'local_write', retryPolicy: 'reconcile' } })
      return { id: invocationId }
    },
    async executeTool({ invoke }) { return invoke() },
    async settleTool({ operation, result }) { run = await store.settleAction({ ...guard(), actionId: operation.id, state: result.status === 'completed' ? 'succeeded' : 'failed' }) },
    async failTool({ operation }) { run = await store.settleAction({ ...guard(), actionId: operation.id, state: 'unknown' }) },
    abort(error) { throw error }
  })
  await withDurableRun(binding, () => f.execute())
  const persisted = await store.getRun(run.id)
  const leaves = persisted.actions.filter(action => action.kind === 'write')
  assert.equal(leaves.length, 2)
  assert.notEqual(leaves[0].id, leaves[1].id)
  assert.deepEqual(leaves.map(action => action.state), ['succeeded', 'succeeded'])
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'a')
  assert.equal(await readFile(path.join(f.root, 'b.txt'), 'utf8'), 'b')
})

test('a thrown reply after a real mutation is unknown to the program and stops the next leaf', async t => {
  const f = await fixture(t, 'await tools.call("write",{path:"uncertain.txt",content:"effect happened"}); await tools.call("write",{path:"no-replay.txt",content:"must not run"});')
  const failures = []
  const binding = createDurableRunBinding({
    async prepareTool({ tool, invocationId }) { return { id: invocationId, effect: tool.name === 'write' ? 'local_write' : 'read' } },
    async executeTool({ tool, invoke }) {
      const reply = await invoke()
      if (tool.name === 'write') throw new Error('fixture lost the reply after a successful write')
      return reply
    },
    async settleTool() {},
    async failTool({ operation, effectStarted }) { failures.push({ effect: operation.effect, effectStarted }) },
    abort(error) { throw error }
  })
  const result = await withDurableRun(binding, () => f.execute())
  assert.equal(await readFile(path.join(f.root, 'uncertain.txt'), 'utf8'), 'effect happened')
  await assert.rejects(readFile(path.join(f.root, 'no-replay.txt')), { code: 'ENOENT' })
  assert.deepEqual(failures, [{ effect: 'local_write', effectStarted: true }])
  const program = result.toolEvents.find(event => event.name === 'tool_program')
  assert.equal(program.metadata.outcomeUnknown, true)
  assert.equal(JSON.parse(program.output).outcomeUnknown, true)
})

test('real strict model loop composes container leaves without a serial-dispatch deadlock', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 60000 }, async t => {
  let advertised = []
  const f = await fixture(t, 'await tools.call("write",{path:"strict.txt",content:"container result"}); const r=await tools.call("read",{path:"strict.txt"}); return r.output;', {}, input => {
    if (!advertised.length) advertised = input.tools.map(tool => tool.name)
  })
  const backend = createDockerExecutionBackend({ image: process.env.KKCODE_STRICT_TEST_IMAGE })
  await backend.ensureReady({ cwd: f.root, contract: { allowedPaths: ['.'] } })
  const leaves = []
  const binding = createDurableRunBinding({
    async prepareTool({ invocationId }) { return { id: invocationId } },
    async executeTool(input) {
      const result = await backend.executeTool(input)
      if (input.tool.name !== 'tool_program') leaves.push({ name: input.tool.name, strict: result.metadata?.isolation?.strict })
      return result
    },
    async settleTool() {}, async failTool() {}, abort(error) { throw error }
  })
  const runSpec = createRunSpec({ sessionId: 'program', model: 'test', provider: 'program_fixture',
    role: { name: 'strict-program-fixture', tools: backend.allowedToolNames }, workspace: { root: f.root, cwd: f.root } })
  const result = await withDurableRun(binding, () => f.execute({ runSpec }))
  assert.ok(advertised.includes('tool_program'), 'without tool_search strict roles must see their permitted formerly deferred tools')
  assert.ok(advertised.includes('lsp'))
  assert.equal(await readFile(path.join(f.root, 'strict.txt'), 'utf8'), 'container result')
  assert.deepEqual(leaves, [{ name: 'write', strict: true }, { name: 'read', strict: true }])
  assert.ok(result.toolEvents.some(event => event.name === 'tool_program' && event.output.includes('container result')))
})
