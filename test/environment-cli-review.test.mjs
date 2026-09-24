import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createEnvironmentsCommand } from '../src/commands/environments.mjs'
import { createRunsCommand } from '../src/commands/runs.mjs'
import { openRunStore } from '../src/storage/run-store.mjs'

const exec = promisify(execFile), image = process.env.KKCODE_STRICT_TEST_IMAGE
async function invoke(factory, args) {
  const previous = console.log, values = []
  console.log = value => values.push(String(value))
  try { await factory().parseAsync(args, { from: 'user' }); return JSON.parse(values.at(-1)) }
  finally { console.log = previous }
}
async function runState(id) {
  const store = await openRunStore({ directory: path.join(process.env.KKCODE_HOME, 'run-store'), readOnly: true })
  try { const run = await store.getRun(id); return { revision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch } }
  finally { await store.close() }
}

async function fixture(t, { environment = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-env-cli-review-'))
  const cwd = path.join(root, 'source'), state = path.join(root, 'state'), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = state
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  await mkdir(cwd)
  const manifest = { name: 'review-fixture', version: '1.0.0' }
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { '': manifest } }))
  await writeFile(path.join(cwd, 'verify.cjs'), 'console.log("fixture")')
  await exec('git', ['init', '-q'], { cwd }); await exec('git', ['add', '.'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source'], { cwd })
  let reference
  if (environment) {
    const common = ['--cwd', cwd, '--image', image, '--registry', 'https://registry.npmjs.org']
    const inspected = await invoke(createEnvironmentsCommand, ['inspect', ...common])
    reference = (await invoke(createEnvironmentsCommand, ['prepare', ...common, '--confirm-hash', inspected.plan.id])).environment
  }
  const contract = path.join(root, 'contract.json')
  await writeFile(contract, JSON.stringify({
    contract: { objective: 'Verify only', allowedPaths: ['.'], allowedTools: ['read', 'bash'], requiredCriteria: [{ id: 'verified', description: 'Verification succeeds' }] },
    acceptance: { required: true, goal: { goalId: 'fixture', objective: 'Verify only', criteria: [{ id: 'verified', kind: 'command_exit', text: 'Verification succeeds', spec: { command: 'node', args: ['verify.cjs'], expect: 0 } }] }, testSources: ['verify.cjs'] },
    limits: { budgetUsd: 0, deadlineAt: Date.now() + 600000 }
  }))
  const args = ['start', '--contract', contract, '--cwd', cwd, '--image', image, '--prepare-only', '--json', ...(reference ? ['--environment', reference.directory] : [])]
  return { cwd, state, args, async start() {
    const preview = await invoke(createRunsCommand, args)
    const run = await invoke(createRunsCommand, [...args, '--confirm', preview.confirmation])
    const filename = path.join(state, 'run-hosts', `${run.runId}.json`)
    return { run, filename, meta: JSON.parse(await readFile(filename, 'utf8')) }
  } }
}

test('recovery cannot remove an approved environment to skip changed manifest verification', { skip: !image, timeout: 120000 }, async t => {
  const { start } = await fixture(t, { environment: true }), { run, filename, meta } = await start()
  const args = ['resume', run.runId, '--json']
  const preview = await invoke(createRunsCommand, args)
  const owner = await runState(run.runId)
  await writeFile(path.join(run.workspace, 'package.json'), JSON.stringify({ name: 'changed-after-approval', version: '1.0.0' }))
  await assert.rejects(invoke(createRunsCommand, [...args, '--confirm', preview.confirmation]), /清单|package\.json|环境|绑定/)
  // Even a newly displayed confirmation cannot replace the original persisted
  // contract binding; a missing environment is not a request for fallback.
  for (const replacement of [undefined, null]) {
    await writeFile(filename, JSON.stringify({ ...meta, dependencyEnvironment: replacement }), { mode: 0o600 })
    await assert.rejects(async () => {
      const second = await invoke(createRunsCommand, args)
      await invoke(createRunsCommand, [...args, '--confirm', second.confirmation])
    }, { code: 'HOST_BINDING_CHANGED' })
    assert.deepEqual(await runState(run.runId), owner, 'changed environment must be rejected before takeover')
  }
})

test('start confirmation is account-bound rather than transferable across login changes', { skip: !image, timeout: 60000 }, async t => {
  const { state, args } = await fixture(t)
  const before = await invoke(createRunsCommand, args)
  await mkdir(path.join(state, 'device'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(state, 'device', 'identity.json'), JSON.stringify({ owner: 'another-fixture-account', ownerGateway: 'https://fixture.invalid', profile: { organization: 'fixture-org' } }), { mode: 0o600 })
  const after = await invoke(createRunsCommand, args)
  assert.notEqual(before.confirmation, after.confirmation, 'the same source/contract plan must be reconfirmed after account changes')
})

test('recovery cannot silently select a different source configuration workspace', { skip: !image, timeout: 60000 }, async t => {
  const { cwd, start } = await fixture(t), { run, filename, meta } = await start()
  const owner = await runState(run.runId)
  const other = path.join(path.dirname(cwd), 'different-source')
  await mkdir(other)
  await writeFile(filename, JSON.stringify({ ...meta, sourceCwd: other }), { mode: 0o600 })
  await assert.rejects(async () => {
    const preview = await invoke(createRunsCommand, ['resume', run.runId, '--json'])
    await invoke(createRunsCommand, ['resume', run.runId, '--json', '--confirm', preview.confirmation])
  }, { code: 'HOST_BINDING_CHANGED' })
  assert.deepEqual(await runState(run.runId), owner, 'changed source must be rejected before takeover')
})
