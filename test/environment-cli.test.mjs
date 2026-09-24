import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createEnvironmentsCommand, inspectRunEnvironment, restoreRunEnvironment } from '../src/commands/environments.mjs'
import { createRunsCommand } from '../src/commands/runs.mjs'
import { createHostServices } from '../src/kernel/core/host-services.mjs'

const exec = promisify(execFile), image = process.env.KKCODE_STRICT_TEST_IMAGE
async function invoke(factory, args) {
  const prior = console.log, values = []
  console.log = value => values.push(String(value))
  try { await factory().parseAsync(args, { from: 'user' }); return JSON.parse(values.at(-1)) }
  finally { console.log = prior }
}

test('environment and run CLI bind the same verified offline environment without installing into the source', { skip: !image, timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-env-cli-')), cwd = path.join(root, 'source'), state = path.join(root, 'state'), prior = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = state
  t.after(async () => { if (prior === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = prior; await rm(root, { recursive: true, force: true }) })
  await mkdir(cwd)
  const manifest = { name: 'cli-fixture', version: '1.0.0', scripts: { install: 'node -e "process.exit(94)"' } }
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': { ...manifest } } }))
  await writeFile(path.join(cwd, 'verify.cjs'), 'console.log("isolated verification")')
  await exec('git', ['init', '-q'], { cwd }); await exec('git', ['add', '.'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source'], { cwd })
  const common = ['--cwd', cwd, '--image', image, '--registry', 'https://registry.npmjs.org']
  const inspected = await invoke(createEnvironmentsCommand, ['inspect', ...common])
  assert.equal(inspected.prepared, false)
  await assert.rejects(access(path.join(state, 'dependency-environments')), { code: 'ENOENT' })
  await assert.rejects(invoke(createEnvironmentsCommand, ['prepare', ...common, '--confirm-hash', '0'.repeat(64)]), /已变化/)
  const prepared = await invoke(createEnvironmentsCommand, ['prepare', ...common, '--confirm-hash', inspected.plan.id])
  assert.equal(prepared.environment.status, 'ready')
  assert.equal(prepared.storageRoot, path.join(state, 'dependency-environments'))
  await assert.rejects(access(path.join(cwd, 'node_modules')), { code: 'ENOENT' })
  const verified = await invoke(createEnvironmentsCommand, ['verify', prepared.environment.directory, '--cwd', cwd, '--image', image])
  assert.equal(verified.valid, true)
  const reference = await inspectRunEnvironment({ environment: prepared.environment.directory, image }, cwd)
  assert.equal(reference.planId, inspected.plan.id)
  assert.equal((await restoreRunEnvironment(reference, { cwd, image })).id, prepared.environment.id)
  await assert.rejects(restoreRunEnvironment({ ...reference, treeHash: '0'.repeat(64) }, { cwd, image }), /不一致/)
  const contract = path.join(root, 'contract.json')
  await writeFile(contract, JSON.stringify({ contract: { objective: 'Verify the approved fixture', allowedPaths: ['.'], allowedTools: ['read', 'bash'], requiredCriteria: [{ id: 'verified', description: 'Frozen verification passes' }] },
    acceptance: { required: true, goal: { goalId: 'environment-fixture', objective: 'Verify the approved fixture', criteria: [{ id: 'verified', kind: 'command_exit', text: 'Frozen verification passes', spec: { command: 'node', args: ['verify.cjs'], expect: 0 } }] }, testSources: ['verify.cjs'] },
    limits: { budgetUsd: 0, deadlineAt: Date.now() + 600000 } }))
  const args = ['start', '--contract', contract, '--cwd', cwd, '--image', image, '--environment', prepared.environment.directory, '--prepare-only', '--json']
  const preview = await invoke(createRunsCommand, args)
  assert.deepEqual(preview.plan.dependencyEnvironment, reference)
  const run = await invoke(createRunsCommand, [...args, '--confirm', preview.confirmation])
  const metadata = JSON.parse(await readFile(path.join(state, 'run-hosts', `${run.runId}.json`), 'utf8'))
  assert.deepEqual(metadata.dependencyEnvironment, reference)
  await access(path.join(run.workspace, 'node_modules'))
  await assert.rejects(access(path.join(cwd, 'node_modules')), { code: 'ENOENT' })
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd })).stdout, '')
})

test('host services and run references reject JSON-shaped dependency capabilities', async () => {
  await assert.rejects(createHostServices(process.cwd(), {}, { dependencyEnvironment: { schema: 'kk.npm-environment.v1', status: 'ready' } }), /正式 SDK/)
  await assert.rejects(restoreRunEnvironment({ directory: '/tmp/fake', authorizeScripts: true }, { cwd: process.cwd(), image: 'fake' }), /引用损坏/)
  await assert.rejects(inspectRunEnvironment({ environmentStore: '/tmp/fake' }, process.cwd()), /一起使用/)
})
