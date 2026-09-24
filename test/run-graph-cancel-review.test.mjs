import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRunsCommand } from '../src/commands/runs.mjs'
import { currentArtifactAccountId } from '../src/kernel/tool/artifacts.mjs'
import { createTaskGraphHost } from '../src/kernel/orchestration/task-graph.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'
import { createArtifactStore } from '../src/storage/artifact-store.mjs'
import { acquireProcessLock } from '../src/storage/process-lock.mjs'

const exec = promisify(execFile)
async function invoke(args) {
  const previous = console.log, values = []
  console.log = value => values.push(String(value))
  try { await createRunsCommand().parseAsync(args, { from: 'user' }); return JSON.parse(values.at(-1)) }
  finally { console.log = previous }
}

test('graph cancellation is ledger-only despite broken metadata and preserves unknown child outcomes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-graph-cancel-review-')), cwd = path.join(root, 'repo'), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  await mkdir(cwd); await writeFile(path.join(cwd, 'README.md'), 'fixture')
  await exec('git', ['init', '-q'], { cwd }); await exec('git', ['add', '.'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd })
  const directory = path.join(root, 'runs'), store = await openRunStore({ directory })
  const actor = { accountId: await currentArtifactAccountId(), projectId: 'cancel-review' }
  const parent = await store.createRun({ id: 'parent', ownerId: 'owner', initialState: 'running', binding: { ...actor, cwd, sessionId: 'session' },
    contract: { objective: 'Review fixture', allowedPaths: [], allowedTools: ['read'], requiredCriteria: [{ id: 'review', description: 'Human review' }] } })
  const host = createTaskGraphHost({ store, artifacts: createArtifactStore(), actor, configState: { config: {} }, authorize: () => true })
  t.after(async () => { await host.close(); await store.close(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const graph = await host.propose({ graphId: 'graph', deadlineAt: Date.now() + 600000, maxConcurrency: 1, budgetUsd: 0.2,
    tasks: [{ task_id: 'pending', prompt: 'Still pending', budget_usd: 0.1 }, { task_id: 'uncertain', prompt: 'Unknown prior outcome', budget_usd: 0.1 }] },
  { parentRunId: parent.id, ownerEpoch: parent.ownerEpoch })
  const update = async next => {
    const current = await store.getRun(parent.id)
    return store.updateTaskGraph({ runId: parent.id, expectedRevision: current.revision, ownerId: current.ownerId, ownerEpoch: current.ownerEpoch, graphId: graph.id, expectedGraphRevision: next.revision, graph: next })
  }
  graph.nodes[1].state = 'preparing'; graph.status = 'running'
  const preparing = await update(graph)
  preparing.nodes[1].state = 'unknown'; preparing.status = 'blocked'
  await update(preparing)
  await mkdir(path.join(process.env.KKCODE_HOME, 'run-hosts'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(process.env.KKCODE_HOME, 'run-hosts', 'parent.json'), '{malformed metadata with unavailable image and environment', { mode: 0o600 })
  const args = ['--directory', directory, 'graph', 'cancel', parent.id, graph.id, '--json']
  const preview = await invoke(args), before = await store.getRun(parent.id)
  await store.transitionRun({ runId: parent.id, expectedRevision: before.revision, ownerId: before.ownerId, ownerEpoch: before.ownerEpoch, state: 'paused', reason: 'Parent control event; graph itself is unchanged' })
  const held = await acquireProcessLock(path.join(process.env.KKCODE_HOME, 'run-execution-locks', `${createHash('sha256').update(parent.id).digest('hex')}.lock`))
  let cancelled
  try { cancelled = (await invoke([...args, '--confirm', preview.confirmation]))[0] }
  finally { await held.release() }
  assert.ok(cancelled.cancelRequestedAt)
  assert.equal(cancelled.nodes[0].state, 'cancelled')
  assert.equal(cancelled.nodes[1].state, 'unknown', 'unknown effects must not be declared cancelled or replayed')
  assert.equal(cancelled.status, 'blocked')
  const after = await store.getRun(parent.id)
  assert.equal(after.ownerId, before.ownerId); assert.equal(after.ownerEpoch, before.ownerEpoch)
  assert.equal(after.state, 'paused', 'graph cancellation cannot resume or take over its parent')
  await mkdir(path.join(process.env.KKCODE_HOME, 'device'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(process.env.KKCODE_HOME, 'device', 'identity.json'), JSON.stringify({ owner: 'different-account' }), { mode: 0o600 })
  await assert.rejects(invoke(args), /账号/)
})
