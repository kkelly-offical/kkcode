import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { createGitHttpFixture } from './forge-http.mjs'
import { createScriptedProvider, stagePlanFence, ultraConfig } from './ultra-harness.mjs'
import { createDelegatedKernel } from '../../src/kernel/isolation/delegation-kernel.mjs'
import { createDockerExecutionBackend } from '../../src/kernel/isolation/docker-executor.mjs'
import { createRunCoordinator } from '../../src/kernel/orchestration/run-coordinator.mjs'
import { openRunStore } from '../../src/storage/run-store.mjs'
import { createArtifactStore } from '../../src/storage/artifact-store.mjs'
import { currentArtifactAccountId } from '../../src/kernel/tool/artifacts.mjs'
import { runHostBindingHash } from '../../src/commands/run-host-binding.mjs'

/** Synthetic model, real tool loop + Docker + frozen original test + durable
 * verification receipt. No hand-written success receipt or fake coordinator. */
export async function createVerifiedForgeRun(t, { kind = 'github', image, cliHostBinding = false }) {
  const cleanups = []
  const f = await createGitHttpFixture({ after: cleanup => cleanups.push(cleanup) }, { kind, initialFiles: {
    'verify.mjs': "import{readFileSync}from'node:fs';if(readFileSync('app.txt','utf8')!=='verified candidate from kernel\\n')process.exit(1)\n",
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node verify.mjs' } })
  } })
  const previous = process.env.KKCODE_HOME
  let kernel, store, coordinator
  t.after(async () => {
    try { await coordinator?.close(); await kernel?.shutdown(); await store?.close() }
    finally { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; for (const cleanup of cleanups) await cleanup() }
  })
  process.env.KKCODE_HOME = path.join(f.base, 'private-state')
  const workspace = path.join(f.base, 'task')
  await f.git(['worktree', 'add', '--detach', workspace, f.targetSha])
  const state = ultraConfig({ providerName: 'forge_fixture', gates: { test: { enabled: true }, smoke: { enabled: false } } }, { ultra: { max_rounds: 1 } })
  state.config.tool.sources.builtin = true
  state.config.git_auto = { enabled: false, auto_snapshot: false }
  state.config.skills = { enabled: false, auto_seed: false }
  state.config.session.title_generation = false
  Object.assign(state.config.provider.forge_fixture, { type: 'openai', api_key: '', api_key_env: '', context_limit: 131072, max_tokens: 1000 })
  const prices = path.join(f.base, 'prices.json')
  await writeFile(prices, JSON.stringify({ models: { 'mock-model': { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  state.source = { userDir: f.base, userRaw: { usage: { pricing_file: prices } } }
  const plan = { planId: 'forge-fixture-plan', objective: 'Produce the exact app text', stages: [{ stageId: 'write', name: 'Write verified result', tasks: [{ taskId: 'write-app', prompt: 'Write app.txt with verified candidate from kernel followed by newline', plannedFiles: ['app.txt'], acceptance: ['npm test'] }] }] }
  const scripted = createScriptedProvider([{ match: /Strict delegated stage/, reply: '[TASK_COMPLETE] implementation complete' },
    { stage: 1, reply: 'Original test inspected; app content must change.' }, { stage: 2, reply: stagePlanFence(plan) }, { stage: 4, reply: '[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]' }])
  let toolStep = 0
  const provider = createServer(async (request, response) => {
    const input = JSON.parse(await Array.fromAsync(request).then(chunks => Buffer.concat(chunks).toString()))
    const text = JSON.stringify(input.messages || [])
    let message, finish = 'stop'
    if (text.includes('Strict delegated stage') && toolStep < 2) {
      const reading = toolStep++ === 0
      finish = 'tool_calls'
      message = { role: 'assistant', content: null, tool_calls: [{ id: `forge-${toolStep}`, type: 'function', function: { name: reading ? 'read' : 'write', arguments: JSON.stringify(reading ? { path: 'app.txt' } : { path: 'app.txt', content: 'verified candidate from kernel\n' }) } }] }
    } else message = { role: 'assistant', content: (await scripted.request(input)).text }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: 'fixture', model: 'mock-model', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) })
  state.config.provider.forge_fixture.base_url = `http://127.0.0.1:${provider.address().port}/v1`
  kernel = await createDelegatedKernel({ cwd: workspace, configState: state, trustState: { trusted: true }, handlers: { onPermissionPrompt: () => 'allow_once' } })
  store = await openRunStore({ directory: path.join(f.base, 'runs') })
  const artifacts = createArtifactStore()
  const acceptance = { required: true, goal: { goalId: 'local-verification', objective: 'Create exact app content, keep original tests intact',
    criteria: [{ id: 'tests', kind: 'gate_pass', text: 'Original npm test passes', spec: { gate: 'test' } }] }, testSources: ['verify.mjs', 'package.json'] }
  const actor = { accountId: await currentArtifactAccountId(), projectId: 'forge-test-project' }
  const hostMetadata = { sourceCwd: f.cwd, workspace, baseRevision: f.targetSha, image, acceptance, actor, networkOrigins: [] }
  const authorizationRequests = []
  coordinator = createRunCoordinator({ kernel, store, artifacts, actor, acceptance, hostBindingHash: cliHostBinding ? runHostBindingHash(hostMetadata) : null, authorize: request => { authorizationRequests.push(request); return true },
    executionBackend: createDockerExecutionBackend({ image }), leaseDirectory: path.join(f.base, 'leases'), grantDirectory: path.join(f.base, 'grants') })
  const run = await coordinator.start({ contract: { objective: 'Produce a verified candidate and allow a draft delivery', allowedPaths: ['.'], allowedTools: ['write', 'read'],
    allowedExternalActions: ['forge.push', 'forge.draft.create', 'forge.draft.update', 'forge.comment', 'forge.ready'], requiredCriteria: [{ id: 'tests', description: 'Original tests pass' }] },
    limits: { budgetUsd: 10, deadlineAt: Date.now() + 120000 } })
  const result = await coordinator.execute({ runId: run.id, prompt: run.contract.objective, mode: 'longagent' })
  return { ...f, sourceCwd: f.cwd, cwd: workspace, kernel, store, artifacts, coordinator, run: result.run, result, actor, acceptance, authorizationRequests }
}
