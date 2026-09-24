import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createDelegatedKernel } from '../src/kernel/isolation/delegation-kernel.mjs'
import { createDockerExecutionBackend } from '../src/kernel/isolation/docker-executor.mjs'
import { createRunCoordinator } from '../src/kernel/orchestration/run-coordinator.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'

const exec = promisify(execFile), image = process.env.KKCODE_STRICT_TEST_IMAGE
test('a real strict tool cannot lower later request reservations by rewriting its project pricing file', { skip: !image, timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-pricing-snapshot-')), main = path.join(root, 'main'), cwd = path.join(root, 'task'), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  await mkdir(main)
  const prices = { currency: 'USD', per_tokens: 1, models: { 'fixture-model': { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }
  const reduced = { ...prices, models: { 'fixture-model': { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }
  await writeFile(path.join(main, 'prices.json'), JSON.stringify(prices))
  await exec('git', ['init', '-q'], { cwd: main }); await exec('git', ['add', '.'], { cwd: main })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: main })
  await exec('git', ['worktree', 'add', '--detach', cwd, 'HEAD'], { cwd: main })
  let calls = 0
  const script = `require('node:fs').writeFileSync('prices.json',${JSON.stringify(JSON.stringify(reduced))})`
  const command = `node -e ${JSON.stringify(script)}`
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const first = calls++ === 0
    const message = first ? { role: 'assistant', content: null, tool_calls: [{ id: 'reduce-fixture-prices', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }
      : { role: 'assistant', content: 'Second request after project price mutation.' }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ model: 'fixture-model', choices: [{ index: 0, message, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const configState = { source: { projectDir: cwd, projectRaw: { usage: { pricing_file: 'prices.json' } } }, config: {
    provider: { default: 'fixture', fixture: { type: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', api_key_env: '', default_model: 'fixture-model', context_limit: 131072, max_tokens: 1000, stream: false } },
    permission: { default_policy: 'allow', rules: [] }, agent: { max_steps: 3 }, session: { title_generation: false, recovery: false },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } }, usage: { pricing_file: 'prices.json', budget: {} }, skills: { enabled: false } } }
  const store = await openRunStore({ directory: path.join(root, 'runs') }), kernel = await createDelegatedKernel({ cwd, configState, trustState: { trusted: true } })
  const coordinator = createRunCoordinator({ kernel, store, artifacts: createArtifactStore({ root: path.join(root, 'artifacts') }), actor: { accountId: 'fixture-account', projectId: 'fixture-project' },
    authorize: () => true, executionBackend: createDockerExecutionBackend({ image }) })
  t.after(async () => { await coordinator.close(); await kernel.shutdown(); await store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const run = await coordinator.start({ limits: { budgetUsd: 133080, deadlineAt: Date.now() + 60000 }, contract: { objective: 'Inspect behavior of a project pricing mutation', allowedPaths: ['.'], allowedTools: ['bash'], requiredCriteria: [{ id: 'budget', description: 'Preserve host-approved prices' }] } })
  const result = await coordinator.execute({ runId: run.id, prompt: 'Use the prepared fixture command once, then continue.' })
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'prices.json'), 'utf8')), reduced, 'the real isolated tool must have actually changed the file')
  assert.equal(calls, 1, `The original price allows one request only. Actual ledger: ${JSON.stringify(result.budget)}`)
  assert.equal(result.budget.profiles[0].rates.input, 1)
  const originalProfile = result.budget.profiles[0].id
  await coordinator.close(); await kernel.shutdown()
  const restartedKernel = await createDelegatedKernel({ cwd, configState, trustState: { trusted: true } }), approvals = []
  const restarted = createRunCoordinator({ kernel: restartedKernel, store, artifacts: createArtifactStore({ root: path.join(root, 'artifacts') }), actor: { accountId: 'fixture-account', projectId: 'fixture-project' },
    authorize: request => { approvals.push(request); return true }, executionBackend: createDockerExecutionBackend({ image }) })
  try {
    await restarted.attach({ runId: run.id })
    const again = await restarted.execute({ runId: run.id, prompt: 'Resume without changing the authorized prices.' })
    assert.equal(calls, 1, 'a new kernel must keep the private approved price snapshot, not the zeroed project file')
    assert.equal(again.budget.profiles[0].id, originalProfile)
    assert.equal(approvals.some(request => request.kind === 'run.budget_profile'), false)
  } finally { await restarted.close(); await restartedKernel.shutdown() }
  const childCwd = path.join(root, 'child')
  await exec('git', ['worktree', 'add', '--detach', childCwd, 'HEAD'], { cwd: main })
  await writeFile(path.join(childCwd, 'prices.json'), JSON.stringify(reduced))
  const childConfig = structuredClone(configState); childConfig.source.projectDir = childCwd
  const childKernel = await createDelegatedKernel({ cwd: childCwd, configState: childConfig, trustState: { trusted: true } })
  const child = createRunCoordinator({ kernel: childKernel, store, artifacts: createArtifactStore({ root: path.join(root, 'artifacts') }), actor: { accountId: 'fixture-account', projectId: 'fixture-project' },
    budgetProfiles: result.budget.profiles, modelRole: 'review', authorize: () => true, executionBackend: createDockerExecutionBackend({ image }) })
  try {
    const childRun = await child.start({ limits: { budgetUsd: 133040, deadlineAt: Date.now() + 60000 }, contract: { objective: 'Review with inherited approved prices', allowedPaths: [], allowedTools: ['read'], requiredCriteria: [{ id: 'review', description: 'Review remains in budget' }] } })
    const childResult = await child.execute({ runId: childRun.id, prompt: 'Read the fixture without repricing the model.' })
    assert.equal(calls, 1, 'child roles must inherit original approved prices rather than loading their editable zero-price file')
    assert.equal(childResult.budget.profiles[0].id, originalProfile)
  } finally { await child.close(); await childKernel.shutdown() }
})
