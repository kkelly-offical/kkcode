import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/kernel.mjs'
import { BackgroundManager } from '../src/kernel/orchestration/background-manager.mjs'
import { nodeFixtureCommand } from './fixtures/process-script.mjs'

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const exists = file => access(file).then(() => true, () => false)

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-background-completion-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(path.join(cwd, 'safe.mjs'), 'export const value = 1;\n')
  const kernel = await createKernel({ cwd, trustState: { trusted: true }, config: { config: {
    provider: { default: 'background-fixture', 'background-fixture': { default_model: 'fixture', retry_attempts: 0 } },
    agent: { max_steps: 5, verify_completion: true }, permission: { level: 'yolo', rules: [] },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
    session: { title_generation: false, recovery: false }, usage: { budget: {} }, ui: { markdown_render: false }
  } } })
  t.after(async () => {
    // Only this disposable fixture's tasks are in this private KKCODE_HOME.
    const tasks = await kernel.run(() => BackgroundManager.list())
    for (const task of tasks) {
      await kernel.run(() => BackgroundManager.cancel(task.id))
      await kernel.run(() => BackgroundManager.waitForTask(task.id, { timeoutMs: 10000, tickMs: 20 }))
    }
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { kernel, cwd }
}

async function launchHeldMutation(kernel, cwd, sessionId, changedContent = 'syntax invalid {') {
  const ready = path.join(cwd, 'background-ready'), release = path.join(cwd, 'background-release')
  const source = "const fs = require('node:fs'); const { changedContent } = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'data.json'), 'utf8')); fs.writeFileSync('background-ready', 'ready'); const timer = setInterval(() => { if (fs.existsSync('background-release')) { fs.writeFileSync('safe.mjs', changedContent); clearInterval(timer); } }, 20)"
  const command = await nodeFixtureCommand(cwd, source, { changedContent })
  let requests = 0
  kernel.providers.registerProvider('background-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() {
      requests++
      if (requests === 1) yield { type: 'tool_call', call: { id: 'held-mutation', name: 'bash', args: { command, run_in_background: true } } }
      else if (requests === 2) {
        for (let attempt = 0; !await exists(ready) && attempt < 250; attempt++) await pause(20)
        assert.equal(await exists(ready), true, 'the fixture background process must actually be running')
        yield { type: 'tool_call', call: { id: 'premature-check', name: 'bash', args: { command: 'node --check safe.mjs' } } }
      } else yield { type: 'text', content: 'The file is complete and checked.' }
    }
  })
  const result = await kernel.executeTurn({ prompt: 'Update safe.mjs and verify the final file.', sessionId, model: 'fixture', providerType: 'background-fixture' })
  const tasks = await kernel.run(() => BackgroundManager.list())
  const task = tasks.find(item => item.payload?.parentSessionId === sessionId)
  assert.ok(task, 'the owned background job must be durably identifiable')
  return { result, task, release }
}

test('a check before background mutation settlement cannot complete its owning turn', async t => {
  const { kernel, cwd } = await fixture(t)
  const { result, task, release } = await launchHeldMutation(kernel, cwd, 'background-owner')
  assert.ok(['pending', 'running'].includes(task.status))
  assert.equal(await readFile(path.join(cwd, 'safe.mjs'), 'utf8'), 'export const value = 1;\n')
  assert.equal(result.status, 'incomplete', 'dispatch is not terminal mutation evidence')
  assert.equal(result.verification?.passed, false)
  await writeFile(release, 'release only this controlled fixture')
  const settled = await kernel.run(() => BackgroundManager.waitForTask(task.id, { timeoutMs: 10000, tickMs: 20 }))
  assert.equal(settled.status, 'completed')
  assert.equal(await readFile(path.join(cwd, 'safe.mjs'), 'utf8'), 'syntax invalid {', 'the job can still mutate after the premature check')
})

test('an unrelated session does not inherit another session background completion barrier', async t => {
  const { kernel, cwd } = await fixture(t)
  const { task } = await launchHeldMutation(kernel, cwd, 'other-background-owner')
  kernel.providers.registerProvider('background-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() { yield { type: 'text', content: 'A status-only answer in a different session.' } }
  })
  const result = await kernel.executeTurn({ prompt: 'Say hello without changing files.', sessionId: 'unrelated-session', model: 'fixture', providerType: 'background-fixture' })
  assert.equal(result.status, 'completed')
  assert.equal((await kernel.run(() => BackgroundManager.get(task.id))).status, 'running')
})

test('settled background mutation needs a fresh check, and a later real check can clear the barrier', async t => {
  const { kernel, cwd } = await fixture(t)
  const sessionId = 'background-post-settlement'
  const { task, release } = await launchHeldMutation(kernel, cwd, sessionId, 'export const value = 2;\n')
  await writeFile(release, 'release only this controlled fixture')
  assert.equal((await kernel.run(() => BackgroundManager.waitForTask(task.id, { timeoutMs: 10000, tickMs: 20 }))).status, 'completed')
  assert.equal(await readFile(path.join(cwd, 'safe.mjs'), 'utf8'), 'export const value = 2;\n')
  kernel.providers.registerProvider('background-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() { yield { type: 'text', content: 'The background operation finished, so everything is verified.' } }
  })
  const unverified = await kernel.executeTurn({ prompt: 'Finish after inspecting the previous background result.', sessionId, model: 'fixture', providerType: 'background-fixture' })
  assert.equal(unverified.status, 'incomplete', 'the earlier check ran before the actual final mutation')
  assert.equal(unverified.verification?.passed, false)
  let requests = 0
  kernel.providers.registerProvider('background-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() {
      if (++requests === 1) yield { type: 'tool_call', call: { id: 'post-settlement-check', name: 'bash', args: { command: 'node --check safe.mjs' } } }
      else yield { type: 'text', content: 'The final file was checked after the background job settled.' }
    }
  })
  const verified = await kernel.executeTurn({ prompt: 'Verify the settled final file now.', sessionId, model: 'fixture', providerType: 'background-fixture' })
  assert.equal(verified.status, 'completed')
  assert.equal(verified.verification?.passed, true)
  assert.equal(verified.verification?.state, 'checks_observed')
})

test('optional verification=false does not complete an owned background command that is still running', async t => {
  const { kernel, cwd } = await fixture(t)
  kernel.configState.config.agent.verify_completion = false
  const { result, task, release } = await launchHeldMutation(kernel, cwd, 'background-without-optional-verification', 'export const value = 2;\n')
  assert.equal(task.status, 'running')
  assert.equal(result.status, 'incomplete')
  assert.equal(result.verification?.passed, false)
  await writeFile(release, 'finish this controlled fixture')
  assert.equal((await kernel.run(() => BackgroundManager.waitForTask(task.id, { timeoutMs: 10000, tickMs: 20 }))).status, 'completed')
})

test('optional verification=false cannot upgrade an unknown legacy background receipt', async t => {
  const { kernel, cwd } = await fixture(t)
  kernel.configState.config.agent.verify_completion = false
  const sessionId = 'legacy-background-without-optional-verification'
  const task = await kernel.run(() => BackgroundManager.launch({ description: 'controlled legacy receipt fixture',
    payload: { workerType: 'bash', parentSessionId: sessionId, command: 'echo legacy', cwd },
    run: async () => 'legacy output without a structured exit result' }))
  await kernel.run(() => BackgroundManager.waitForTask(task.id, { timeoutMs: 10000, tickMs: 20 }))
  kernel.providers.registerProvider('background-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() { yield { type: 'text', content: 'Report the preserved background receipt.' } }
  })
  const result = await kernel.executeTurn({ prompt: 'Inspect the preserved result.', sessionId, model: 'fixture', providerType: 'background-fixture' })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.verification?.passed, false)
  assert.notEqual(result.verification?.state, 'checks_observed')
})
