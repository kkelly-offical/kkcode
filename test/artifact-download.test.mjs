import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { downloadArtifact } from '../src/sdk/client.mjs'

const id = 'art_00000000-0000-0000-0000-000000000000'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(bytes, mutate = page => page) {
  let requests = 0
  return { get requests() { return requests }, async request(method, params) {
    assert.equal(method, 'artifacts.download'); assert.equal(params.sessionId, 'session')
    const offset = params.cursor ? Number(params.cursor) : 0, end = Math.min(bytes.length, offset + 5)
    requests++
    return mutate({ id, sha256: hash(bytes), size: bytes.length, offset, encoding: 'base64', data: bytes.subarray(offset, end).toString('base64'), mime: 'text/html', nextCursor: end < bytes.length ? String(end) : null })
  } }
}
test('browser SDK download reconstructs exact multibyte output and checks the whole file before offering it', async () => {
  const bytes = Buffer.from('中文及emoji🙂<script>untrusted</script>'), client = fixture(bytes), progress = []
  const result = await downloadArtifact(client, { sessionId: 'session', id, onProgress: (n, total) => progress.push([n, total]) })
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes)
  assert.equal(result.blob.type, 'application/octet-stream')
  assert.equal(result.sha256, hash(bytes)); assert.deepEqual(progress.at(-1), [bytes.length, bytes.length])
  assert.ok(client.requests > 1)
})
test('invalid, mismatched, repeated and over-limit artifact pages never become downloadable files', async () => {
  const bytes = Buffer.from('long enough text')
  for (const mutate of [
    page => ({ ...page, id: 'another' }), page => ({ ...page, offset: page.offset + 1 }),
    page => ({ ...page, sha256: '0'.repeat(64) }), page => ({ ...page, size: 200 * 1024 * 1024 }),
    page => ({ ...page, data: '???' }), page => ({ ...page, nextCursor: '' }),
    page => ({ ...page, data: '', nextCursor: 'repeat' }), page => ({ ...page, nextCursor: null })
  ]) await assert.rejects(downloadArtifact(fixture(bytes, mutate), { sessionId: 'session', id }), { code: 'artifact_download_invalid' })
})
test('download cancellation stops before making another device request and empty files remain valid', async () => {
  const controller = new AbortController(), client = fixture(Buffer.from('a longer file'))
  await assert.rejects(downloadArtifact(client, { sessionId: 'session', id, signal: controller.signal, onProgress() { controller.abort() } }), { name: 'AbortError' })
  assert.equal(client.requests, 1)
  const result = await downloadArtifact(fixture(Buffer.alloc(0)), { sessionId: 'session', id })
  assert.equal(result.size, 0); assert.equal(result.sha256, hash(''))
})
