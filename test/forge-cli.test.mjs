import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'node:http'
import { createVerifiedForgeRun } from './helpers/verified-forge-run.mjs'
import { TOKEN } from './helpers/forge-http.mjs'
import { writePrivateFile } from '../src/storage/private-file.mjs'
import { parseForgeRemote } from '../src/sdk/forge.mjs'
import { runHostBindingHash } from '../src/commands/run-host-binding.mjs'

const exec = promisify(execFile), cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url))

test('CLI dry-run, confirmed candidate preparation, push and draft share the actual durable run', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 120000 }, async t => {
  const image = process.env.KKCODE_STRICT_TEST_IMAGE
  const f = await createVerifiedForgeRun(t, { image, cliHostBinding: true })
  assert.equal(f.result.verified, true)
  const stateRoot = process.env.KKCODE_HOME, metadata = path.join(stateRoot, 'run-hosts', `${f.run.id}.json`)
  await mkdir(path.dirname(metadata), { recursive: true, mode: 0o700 })
  await writePrivateFile(metadata, JSON.stringify({ schema: 'kk.run-host.v1', runId: f.run.id, sourceCwd: f.sourceCwd, workspace: f.cwd,
    baseRevision: f.targetSha, image, acceptance: f.acceptance, actor: f.actor, confirmation: 'fixture already accepted', networkOrigins: [] }))
  const invoke = async args => {
    const result = await exec(process.execPath, [cli, 'runs', '--directory', path.join(f.base, 'runs'), 'forge', ...args], {
      env: { ...process.env, KKCODE_HOME: stateRoot, KK_TEST_FORGE_TOKEN: TOKEN }, timeout: 30000, maxBuffer: 2 * 1024 * 1024
    })
    assert.ok(!result.stdout.includes(TOKEN)); assert.ok(!result.stderr.includes(TOKEN))
    return JSON.parse(result.stdout)
  }
  const prepareArgs = ['prepare', f.run.id, '--repository', f.repository.remote, '--kind', 'github', '--source-branch', 'kk/verified',
    '--target-branch', 'main', '--target-sha', f.targetSha, '--allow-private', '--token-env', 'KK_TEST_FORGE_TOKEN', '--trust']
  const before = await f.store.getRun(f.run.id)
  const dry = await invoke(prepareArgs)
  assert.equal(dry.executed, false)
  assert.equal((await f.store.getRun(f.run.id)).revision, before.revision, 'preview must not take over ownership or create actions')
  const prepared = await invoke([...prepareArgs, '--confirm', dry.confirmation])
  assert.equal(prepared.prepared, true); assert.equal(prepared.pushed, false)
  const saved = JSON.parse(await readFile(metadata, 'utf8'))
  assert.equal(saved.forge.binding.candidateHash, f.run.candidateHash)
  assert.ok(!JSON.stringify(saved).includes(TOKEN))
  const pushArgs = ['push', f.run.id, '--action-id', 'cli-push-1', '--token-env', 'KK_TEST_FORGE_TOKEN', '--trust']
  const pushPlan = await invoke(pushArgs)
  const pushed = await invoke([...pushArgs, '--confirm', pushPlan.confirmation])
  assert.equal(pushed.status, 'succeeded', JSON.stringify(pushed))
  const body = path.join(f.base, 'body.md'); await writeFile(body, 'Real CLI delivery after independent frozen-test acceptance.')
  const draftArgs = ['draft', f.run.id, '--action-id', 'cli-draft-1', '--title', 'CLI verified draft', '--body-file', body, '--token-env', 'KK_TEST_FORGE_TOKEN', '--trust']
  const draftPlan = await invoke(draftArgs)
  assert.equal((await invoke([...draftArgs, '--confirm', draftPlan.confirmation])).status, 'succeeded')
  const inspectArgs = ['inspect', f.run.id, '--number', '1', '--token-env', 'KK_TEST_FORGE_TOKEN']
  const inspectPreview = await invoke(inspectArgs)
  assert.equal(inspectPreview.executed, false)
  assert.match(inspectPreview.plan.credentialNotice, /发送.*认证令牌/)
  assert.equal(inspectPreview.plan.apiOrigin, new URL(f.repository.apiBase).origin)
  assert.equal((await invoke(['inspect', f.run.id, '--number', '1', '--token-env', 'KK_FORGE_REVIEW_TOKEN_NOT_SET'])).executed, false, 'preview must not try reading a missing token')
  const normalMetadata = JSON.parse(await readFile(metadata, 'utf8'))
  let unapprovedRequests = 0, unapprovedCredentials = 0
  const unapproved = createServer((request, response) => {
    unapprovedRequests++; if (request.headers.authorization === `Bearer ${TOKEN}`) unapprovedCredentials++
    response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}')
  })
  await new Promise(resolve => unapproved.listen(0, '127.0.0.1', resolve))
  t.after(async () => { unapproved.closeAllConnections(); await new Promise(resolve => unapproved.close(resolve)) })
  const redirectedRepository = parseForgeRemote(`http://127.0.0.1:${unapproved.address().port}/changed/project.git`, { kind: 'github' })
  const changedMetadata = { ...normalMetadata, forge: { ...normalMetadata.forge, repository: redirectedRepository, allowPrivate: true,
    binding: { ...normalMetadata.forge.binding, repositoryId: redirectedRepository.id }, contract: { ...normalMetadata.forge.contract, repositoryId: redirectedRepository.id } } }
  assert.equal(runHostBindingHash(changedMetadata), runHostBindingHash(normalMetadata), 'delivery destination is separately approved after the original execution host binding')
  await writePrivateFile(metadata, JSON.stringify(changedMetadata))
  const changedPreview = await invoke(inspectArgs)
  assert.equal(changedPreview.executed, false)
  assert.equal(changedPreview.plan.apiOrigin, new URL(redirectedRepository.apiBase).origin)
  assert.notEqual(changedPreview.confirmation, inspectPreview.confirmation)
  const staleConfirmation = await invoke([...inspectArgs, '--confirm', inspectPreview.confirmation])
  assert.equal(staleConfirmation.executed, false)
  assert.equal(unapprovedRequests, 0); assert.equal(unapprovedCredentials, 0, 'tampered metadata cannot send even a synthetic token to an unconfirmed origin')
  await writePrivateFile(metadata, JSON.stringify(normalMetadata))
  const inspected = await invoke([...inspectArgs, '--confirm', inspectPreview.confirmation])
  assert.equal(inspected.repositoryId, f.repository.id)
  assert.equal(inspected.status, 'blocked', 'complete reads with no successful checks/reviews are not approval')
  assert.equal(inspected.localCandidateRevalidated, false)
  const again = await invoke(draftArgs)
  const reconciled = await invoke([...draftArgs, '--confirm', again.confirmation])
  assert.equal(reconciled.reconciled, true)
  assert.equal(f.effects.filter(effect => effect.operation === 'draft').length, 1)
  assert.equal((await f.store.getRun(f.run.id)).state, 'waiting_input', 'delivery does not merge or mark the whole task completed')
  await writeFile(path.join(f.cwd, 'app.txt'), 'local candidate has since changed')
  const observing = ['reconcile', f.run.id, '--action-id', 'cli-draft-1', '--token-env', 'KK_TEST_FORGE_TOKEN']
  const observationPlan = await invoke(observing), ledgerBefore = await f.store.getRun(f.run.id)
  const observation = await invoke([...observing, '--confirm', observationPlan.confirmation])
  assert.equal(observation.status, 'succeeded'); assert.equal(observation.candidateRevalidated, false)
  assert.equal((await f.store.getRun(f.run.id)).revision, ledgerBefore.revision, 'resolved action observation must not take over or rewrite a receipt')
  assert.equal(f.effects.filter(effect => effect.operation === 'draft').length, 1)
})
