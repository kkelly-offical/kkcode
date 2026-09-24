import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createDelegatedKernel } from '../src/kernel/isolation/delegation-kernel.mjs'
import { createDockerExecutionBackend } from '../src/kernel/isolation/docker-executor.mjs'
import { createRunCoordinator } from '../src/kernel/orchestration/run-coordinator.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { browserStatus } from '../src/kernel/browser/controller.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

const exec = promisify(execFile)
async function fixture(t, { actions = [], allowedPaths = ['.'], confirm = true, clicks = 1, loseReply = false, errorAfterClick = false } = {}) {
  if (!(await browserStatus()).installed) {
    if (process.env.KKCODE_REQUIRE_STRICT_BROWSER === '1' || process.env.KKCODE_REQUIRE_BROWSER === '1') assert.fail('The required dedicated Chromium engine is unavailable')
    t.skip('Dedicated Chromium component fixture requires the installed browser'); return null
  }
  const sandbox = process.platform !== 'linux' || process.getuid?.() !== 0
  const strictImage = process.env.KKCODE_STRICT_TEST_IMAGE, strictBackend = Boolean(strictImage && sandbox)
  if (process.env.KKCODE_REQUIRE_STRICT_BROWSER === '1') assert.equal(strictBackend, true, 'strict CI must exercise the real Docker broker and native Chromium sandbox')
  t.diagnostic(strictBackend ? 'Actual Docker broker + sandboxed Chromium + loopback HTTP' : `Coordinator/Chromium component fixture only; native sandbox=${sandbox}, no strict broker claim`)
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-run-browser-effects-')), cleanup = createFixtureCleanup(t), oldHome = process.env.KKCODE_HOME
  cleanup.remove(root)
  cleanup.defer(() => { if (oldHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = oldHome })
  process.env.KKCODE_HOME = path.join(root, 'private')
  const main = path.join(root, 'main'), cwd = path.join(root, 'task')
  await mkdir(main); await writeFile(path.join(main, 'README.md'), 'baseline\n')
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], ['worktree', 'add', '--detach', cwd, 'HEAD']]) await exec('git', args, { cwd: main })
  const html = '<title>Scoped effects</title><form method="post" action="/effect"><button>Commit</button></form>'
  let writes = 0, calls = 0
  const app = createServer((request, response) => {
    if (request.method === 'POST') { writes++; if (loseReply) { request.socket.destroy(); return } }
    response.setHeader('content-type', 'text/html'); response.end(html)
  })
  const listen = async server => {
    cleanup.defer(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
  }
  const origin = await listen(app)
  const provider = createServer(async (request, response) => {
    for await (const _ of request) { /* drain only this synthetic model request */ }
    const index = calls++, args = index === 0 ? { action: 'open', url: origin } : { action: 'click', role: 'button', name: 'Commit' }
    const message = index <= clicks ? { role: 'assistant', content: null, tool_calls: [{ id: `browser-${index}`, type: 'function', function: { name: 'browser', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Finished inspecting the observed outcome.' }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: `fixture-${index}`, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: index <= clicks ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }))
  })
  const baseUrl = await listen(provider), pricing = path.join(root, 'prices.json')
  await writeFile(pricing, JSON.stringify({ models: { 'fixture-model': { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: pricing } } }, config: {
    provider: { default: 'fixture', fixture: { type: 'openai', base_url: `${baseUrl}/v1`, api_key: '', api_key_env: '', default_model: 'fixture-model', context_limit: 131072, max_tokens: 1000, stream: false, retry_attempts: 0 } },
    agent: { default_mode: 'agent', max_steps: 6, verify_completion: false }, permission: { level: 'yolo', rules: [] },
    session: { recovery: false, title_generation: false }, skills: { enabled: false, auto_seed: false },
    // Root-only component fixtures cannot exercise Chromium's OS sandbox.
    // The dedicated non-root strict CI path uses the actual broker and sandbox.
    tool: { browser: { chromium_sandbox: sandbox }, sources: { builtin: true, local: false, mcp: false, plugin: false } },
    data_policy: { web_origins: [origin] }, usage: { aggregation: ['turn'], budget: {} }
  } }
  const store = cleanup.own(await openRunStore({ directory: path.join(root, 'runs') }))
  const kernel = await createDelegatedKernel({ cwd, configState, trustState: { trusted: true } })
  cleanup.defer(() => kernel.shutdown())
  const approvals = []
  const backend = strictBackend ? createDockerExecutionBackend({ image: strictImage, networkOrigins: [origin] })
    : { allowedToolNames: ['browser'], ensureReady: async () => ({ strict: true, backend: 'component-fixture-only' }), executeTool: ({ invoke }) => invoke() }
  const executeTool = backend.executeTool.bind(backend)
  const coordinator = cleanup.own(createRunCoordinator({ kernel, store, artifacts: createArtifactStore({ root: path.join(root, 'artifacts') }), actor: { accountId: 'fixture', projectId: 'browser' },
    authorize: request => { approvals.push(request); return request.kind === 'run.tool' ? typeof confirm === 'function' ? confirm({ request, kernel, origin }) : confirm : true },
    executionBackend: { ...backend, async executeTool(call) {
      const result = await executeTool(call)
      return errorAfterClick && call.args.action === 'click' ? { status: 'error', output: 'error: synthetic receipt failure after actual HTTP effect' } : result
    } }
  }))
  const run = await coordinator.start({ contract: { objective: 'Inspect synthetic form; act only with separate exact host consent', allowedPaths, allowedTools: ['browser'], allowedNetworkOrigins: [origin], allowedExternalActions: actions, requiredCriteria: [{ id: 'effects', description: 'Host checks actual HTTP effects and persisted authorization' }] }, limits: { budgetUsd: 10, deadlineAt: Date.now() + 60000 } })
  return { coordinator, store, run, origin, approvals, writes: () => writes, calls: () => calls }
}

test('workspace write scope and Browser advertisement never authorize an external form POST', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return
  const result = await f.coordinator.execute({ runId: f.run.id, prompt: 'Open the synthetic page and click Commit.' })
  assert.equal(f.writes(), 0)
  assert.equal(result.run.actions.filter(action => action.effect === 'external_write').length, 0)
  assert.ok(result.turn.toolEvents.some(event => event.name === 'browser' && event.status !== 'completed'))
})

test('an exact Browser external action still requires real host consent, not another declared action', { timeout: 60000 }, async t => {
  for (const options of [{ actions: ['browser.fill'] }, { actions: ['browser.click'], confirm: false }]) await t.test(JSON.stringify(options), async sub => {
    const f = await fixture(sub, options); if (!f) return
    await f.coordinator.execute({ runId: f.run.id, prompt: 'Open then click the synthetic form.' })
    assert.equal(f.writes(), 0)
  })
})

test('each explicitly approved Browser click has a separate origin-bound external-write receipt', { timeout: 60000 }, async t => {
  const f = await fixture(t, { actions: ['browser.click'], allowedPaths: [], clicks: 2 }); if (!f) return
  const result = await f.coordinator.execute({ runId: f.run.id, prompt: 'Perform both separately approved fixture clicks.' })
  assert.equal(f.writes(), 2)
  const confirmations = f.approvals.filter(request => request.kind === 'run.tool')
  assert.equal(confirmations.length, 2)
  for (const request of confirmations) {
    assert.equal(request.action.kind, 'browser.click')
    assert.equal(request.browser.origin, f.origin)
    assert.match(request.browser.fingerprint, /^[a-f0-9]{64}$/)
  }
  const writes = result.run.actions.filter(action => action.effect === 'external_write')
  assert.equal(writes.length, 2)
  assert.ok(writes.every(action => action.state === 'succeeded' && action.retryPolicy === 'reconcile' && action.target.startsWith(f.origin)))
  assert.notEqual(writes[0].id, writes[1].id)
})

test('a filesystem read-only task can inspect an allowed page without acquiring external write authority', { timeout: 60000 }, async t => {
  const f = await fixture(t, { allowedPaths: [], clicks: 0 }); if (!f) return
  const result = await f.coordinator.execute({ runId: f.run.id, prompt: 'Read the allowed synthetic form, do not submit it.' })
  assert.equal(f.writes(), 0)
  assert.ok(result.run.actions.some(action => action.kind === 'tool.browser' && action.effect === 'read' && action.state === 'succeeded'))
  assert.equal(f.approvals.filter(request => request.kind === 'run.tool').length, 0)
})

test('a page changed during real host confirmation cannot use the previous Browser authorization', { timeout: 60000 }, async t => {
  const f = await fixture(t, { actions: ['browser.click'], confirm: async ({ request, kernel, origin }) => {
    const browser = await kernel.tools.get('browser')
    await browser.execute({ action: 'open', url: `${origin}/changed` }, { cwd: kernel.cwd, sessionId: request.action.context.sessionId, configState: kernel.configState, config: kernel.configState.config })
    return true
  } }); if (!f) return
  await f.coordinator.execute({ runId: f.run.id, prompt: 'Request a click while the owner changes pages.' })
  assert.equal(f.writes(), 0)
  assert.equal(f.approvals.filter(request => request.kind === 'run.tool').length, 1)
})

test('an error result after an actual non-idempotent Browser effect remains unknown and stops subsequent calls', { timeout: 60000 }, async t => {
  const f = await fixture(t, { actions: ['browser.click'], clicks: 2, errorAfterClick: true }); if (!f) return
  const result = await f.coordinator.execute({ runId: f.run.id, prompt: 'Do not retry a lost action receipt.' })
  assert.equal(f.writes(), 1)
  assert.equal(f.calls(), 2, 'the model must not receive a second opportunity to repeat the uncertain click')
  assert.equal(result.run.state, 'outcome_unknown')
  assert.equal(result.run.actions.find(action => action.effect === 'external_write').state, 'unknown')
})
