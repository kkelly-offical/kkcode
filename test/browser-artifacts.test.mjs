import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactStore } from '../src/storage/artifact-store.mjs'
import { archiveBrowserFile, archiveBinaryArtifact, readBrowserUpload, authorizeBrowserArtifacts, createTaskArtifactAccess, trustedArtifactRef, trustedArtifactRefs } from '../src/kernel/tool/artifacts.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-browser-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ArtifactStore({ root }), actor = { accountId: 'a', projectId: 'p', sessionId: 's', runId: 'r' }
  const access = createTaskArtifactAccess({ store, resolveActor: async () => actor })
  return { root, store, actor, access }
}

test('browser binary artifact round trip is opaque, scoped, hash verified and does not persist URL credentials or filenames', async t => {
  const { access, store, actor } = await fixture(t)
  assert.deepEqual(await authorizeBrowserArtifacts(access), { authorized: true })
  await assert.rejects(authorizeBrowserArtifacts({ ...access }), error => error.code === 'artifact_host_required')
  const bytes = Buffer.alloc(700000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  const ref = await archiveBrowserFile({ access, content: bytes, mime: 'image/png', filename: '/private/secret.html', sourceUrl: 'https://example.invalid/download?token=hidden#secret', callId: 'download' })
  assert.equal(trustedArtifactRef({ metadata: { artifactRef: ref } }), ref)
  const metadata = await store.getMetadata({ actor, id: ref.id })
  assert.equal(metadata.source.kind, 'web')
  assert.doesNotMatch(JSON.stringify(metadata), /example|hidden|private|secret\.html/)
  const result = await readBrowserUpload({ access, id: ref.id })
  assert.deepEqual(result.buffer, bytes); assert.equal(result.mime, 'image/png'); assert.equal(result.filename, `${ref.id}.png`)
  const other = createTaskArtifactAccess({ store, resolveActor: async () => ({ ...actor, sessionId: 'other' }) })
  await assert.rejects(readBrowserUpload({ access: other, id: ref.id }), error => error.code === 'artifact_not_found')
  await assert.rejects(readBrowserUpload({ access: { ...access }, id: ref.id }), error => error.code === 'artifact_host_required')
  await assert.rejects(archiveBrowserFile({ access, content: bytes, sourceUrl: 'https://user:password@example.invalid/' }), error => error.code === 'artifact_invalid')
})

test('browser transfer caps and cancellation release storage without publishing partial files', { timeout: 10000 }, async t => {
  const { access } = await fixture(t)
  const content = { [Symbol.asyncIterator]() { return { next: async () => ({ value: Buffer.alloc(16 * 1024 * 1024 + 1), done: false }), return: () => new Promise(() => {}) } } }
  await assert.rejects(archiveBrowserFile({ access, content, callId: 'too-big' }), error => error.code === 'artifact_file_quota')
  assert.equal((await access.list()).items.length, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(archiveBrowserFile({ access, content: Buffer.from('cancelled'), signal: controller.signal }))
  const ref = await archiveBrowserFile({ access, content: Buffer.from('valid'), mime: 'text/plain' })
  await assert.rejects(readBrowserUpload({ access, id: ref.id, maxBytes: 4 }), error => error.code === 'artifact_file_quota')
  await assert.rejects(readBrowserUpload({ access, id: ref.id, signal: controller.signal }))
  assert.equal((await readBrowserUpload({ access, id: ref.id })).buffer.toString(), 'valid')
})

test('browser upload denies payload tampering and lease changes before exposing bytes', async t => {
  const { access, store, root, actor } = await fixture(t)
  const ref = await archiveBrowserFile({ access, content: Buffer.from('original') })
  const payload = path.join(root, 'objects', `${ref.id}.bin`)
  await writeFile(payload, 'tampered', { mode: 0o600 })
  await assert.rejects(readBrowserUpload({ access, id: ref.id }), error => error.code === 'artifact_corrupt')
  let checks = 0
  const governed = createTaskArtifactAccess({ store, resolveActor: async () => { if (++checks > 2) throw new Error('lease changed'); return actor } })
  const valid = await archiveBrowserFile({ access, content: Buffer.from('new') })
  await assert.rejects(readBrowserUpload({ access: governed, id: valid.id }), /lease changed/)
})

test('document binary archival preserves only immutable host references and rejects an incomplete producer', async t => {
  const { access } = await fixture(t)
  const refs = []
  for (const content of ['pdf bytes', 'image bytes']) refs.push(await archiveBinaryArtifact({ access, content: Buffer.from(content), mime: 'application/octet-stream' }))
  assert.deepEqual(trustedArtifactRefs({ metadata: { artifactRef: refs[0], artifactRefs: [refs[0], { ...refs[0] }, refs[1], { id: 'fake' }] } }), refs)
  assert.throws(() => { refs[0].sha256 = '0'.repeat(64) }, TypeError)
  const broken = async function* () { yield Buffer.from('partial'); throw new Error('producer hash mismatch') }
  await assert.rejects(archiveBinaryArtifact({ access, content: broken() }), /producer hash mismatch/)
  assert.equal((await access.list()).items.length, 2)
  await assert.rejects(archiveBinaryArtifact({ access, content: Buffer.from('too much'), maxBytes: 2 }), error => error.code === 'artifact_file_quota')
})
