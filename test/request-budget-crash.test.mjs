import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { openRunStore } from '../src/storage/run-store.mjs'

const exec = promisify(execFile)
test('SIGKILL after real HTTP dispatch retains a durable reservation and fresh kernel takeover cannot spend it twice', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-budget-kill-')), main = path.join(root, 'main'), cwd = path.join(root, 'worktree'), directory = path.join(root, 'runs')
  await mkdir(main); await writeFile(path.join(main, 'README.md'), 'fixture')
  await exec('git', ['init', '-q'], { cwd: main }); await exec('git', ['add', '.'], { cwd: main })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: main })
  await exec('git', ['worktree', 'add', '--detach', cwd, 'HEAD'], { cwd: main })
  let calls = 0, dispatch
  const dispatched = new Promise(resolve => { dispatch = resolve })
  const server = createServer(async request => { for await (const _chunk of request) { /* consume */ } calls++; dispatch() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const pricing = path.join(root, 'pricing.json')
  await writeFile(pricing, JSON.stringify({ models: { fixture: { input: 1, output: 2, cache_read: 1, cache_write: 1 } } }))
  const configuration = { directory, cwd, artifacts: path.join(root, 'artifacts'), actor: { accountId: 'budget-fixture', projectId: 'project-fixture' }, limits: { budgetUsd: 1, deadlineAt: Date.now() + 600000 },
    configState: { source: { userDir: root, userRaw: { usage: { pricing_file: pricing } } }, config: { provider: { default: 'fixture', fixture: { type: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', api_key_env: '', default_model: 'fixture', stream: false, context_limit: 131072, max_tokens: 1000, retry_attempts: 5, timeout_ms: 10000 } },
      permission: { default_policy: 'allow', rules: [] }, agent: { max_steps: 1 }, session: { title_generation: false }, tool: { sources: { builtin: true, local: false, mcp: false, plugin: false } }, usage: { budget: {} }, skills: { enabled: false } } } }
  const file = path.join(root, 'fixture.json'); await writeFile(file, JSON.stringify(configuration))
  const workers = [], launch = () => { const child = fork(fileURLToPath(new URL('./fixtures/request-budget-crash-worker.mjs', import.meta.url)), [file], { env: { ...process.env, KKCODE_HOME: path.join(root, 'state') }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(child); return child }
  t.after(async () => { for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const first = launch()
  await Promise.race([dispatched, once(first, 'exit').then(() => { throw new Error('worker exited before HTTP dispatch') })])
  if (process.env.NODE_V8_COVERAGE) {
    const checkpoint = once(first, 'message')
    first.send({ type: 'checkpoint-before-crash' })
    const [message] = await checkpoint
    assert.equal(message.type, 'crash-checkpoint-ready')
  }
  const firstExit = once(first, 'exit'); first.kill('SIGKILL'); await firstExit
  let store = await openRunStore({ directory })
  const before = await store.getRunBudget({ runId: 'durable-model-request' })
  assert.equal(before.requests.length, 1); assert.equal(before.requests[0].status, 'reserved'); assert.ok(before.reservedUsd > 0)
  await store.close()
  const second = launch(), [message] = await once(second, 'message')
  assert.equal(message.code, 'TASK_BUDGET_OUTCOME_UNKNOWN')
  await once(second, 'exit')
  store = await openRunStore({ directory })
  try {
    const after = await store.getRunBudget({ runId: 'durable-model-request' })
    assert.equal(after.requests.length, 1); assert.equal(after.requests[0].status, 'unknown')
    assert.equal(after.unknownUsd, before.reservedUsd); assert.equal(calls, 1)
  } finally { await store.close() }
})
