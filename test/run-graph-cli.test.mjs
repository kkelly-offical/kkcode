import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createRunsCommand } from '../src/commands/runs.mjs'
import { validateTaskGraphHostConfig, confirmGraphActionInTerminal } from '../src/commands/run-graph.mjs'
import { currentArtifactAccountId } from '../src/kernel/tool/artifacts.mjs'
import { createTaskGraphHost } from '../src/kernel/orchestration/task-graph.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-graph-cli-')), cwd = path.join(root, 'repo'), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  await mkdir(cwd); await writeFile(path.join(cwd, 'README.md'), 'fixture')
  await exec('git', ['init', '-q'], { cwd }); await exec('git', ['add', '.'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd })
  const directory = path.join(root, 'runs'), store = await openRunStore({ directory }), actor = { accountId: await currentArtifactAccountId(), projectId: 'fixture-project' }
  const parent = await store.createRun({ id: 'cli-parent', ownerId: 'cli-owner', initialState: 'running', binding: { ...actor, cwd, sessionId: 'cli-session', contractApprovalRef: 'approved-fixture' }, contract: { objective: 'Review safely', allowedPaths: [], allowedTools: ['read'], requiredCriteria: [{ id: 'check', description: 'Human review' }] } })
  const taskGraph = { budgetUsd: 1, deadlineAt: Date.now() + 600000, maxConcurrency: 1 }, artifacts = createArtifactStore()
  const host = createTaskGraphHost({ store, artifacts, actor, configState: { config: {} }, image: `sha256:${'a'.repeat(64)}`, authorize: () => true })
  const graph = await host.propose({ graphId: 'cli-graph', deadlineAt: taskGraph.deadlineAt, maxConcurrency: 1, budgetUsd: 0.1, tasks: [{ prompt: 'Read fixture', budget_usd: 0.1 }] }, { parentRunId: parent.id, ownerEpoch: parent.ownerEpoch })
  const meta = { schema: 'kk.run-host.v1', runId: parent.id, actor, sourceCwd: cwd, workspace: cwd, image: `sha256:${'a'.repeat(64)}`, taskGraph }
  await mkdir(path.join(process.env.KKCODE_HOME, 'run-hosts'), { recursive: true })
  await writeFile(path.join(process.env.KKCODE_HOME, 'run-hosts', `${parent.id}.json`), JSON.stringify(meta), { mode: 0o600 })
  t.after(async () => { await host.close(); await store.close(); if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  return { store, directory, parent, graph }
}
async function command(args) {
  const values = [], old = console.log
  console.log = value => values.push(String(value))
  try { await createRunsCommand().parseAsync(args, { from: 'user' }) } finally { console.log = old }
  return JSON.parse(values.at(-1))
}

test('task graph CLI inspects readonly, prints an exact confirmation and cancels only after that confirmation', async t => {
  const f = await fixture(t), base = ['--directory', f.directory, 'graph']
  const rows = await command([...base, 'inspect', f.parent.id, '--json'])
  assert.equal(rows[0].id, f.graph.id)
  const before = await f.store.getRun(f.parent.id)
  const dry = await command([...base, 'cancel', f.parent.id, f.graph.id, '--json'])
  assert.equal(dry.prepared, false); assert.match(dry.confirmation, /^[a-f0-9]{64}$/)
  assert.equal((await f.store.getRun(f.parent.id)).revision, before.revision)
  const cancelled = await command([...base, 'cancel', f.parent.id, f.graph.id, '--json', '--confirm', dry.confirmation])
  assert.equal(cancelled[0].status, 'cancelled')
})

test('graph host configuration requires explicit bounded limits and a non-TTY is never blanket approval', async () => {
  assert.equal(validateTaskGraphHostConfig(undefined), null)
  assert.throws(() => validateTaskGraphHostConfig({ budgetUsd: 0, deadlineAt: Date.now() + 10000, maxConcurrency: 1 }), /明确/)
  assert.throws(() => validateTaskGraphHostConfig({ budgetUsd: 1, deadlineAt: Date.now() + 10000, maxConcurrency: 1, allowAll: true }), /明确/)
  if (!process.stdin.isTTY) assert.equal(await confirmGraphActionInTerminal({ kind: 'run.tool', tool: 'write' }), false)
})
