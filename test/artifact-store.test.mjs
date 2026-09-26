import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, chmod, readdir, unlink, symlink, mkdir, stat, link } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { ArtifactStore, ARTIFACT_LIMITS } from '../src/storage/artifact-store.mjs'

const actor = { accountId: 'account-a', projectId: 'project-a', sessionId: 'session-a', runId: 'run-a' }
const code = expected => error => error.code === expected
let directory, root, store
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'kk-artifact-test-'))
  root = path.join(directory, 'private-artifacts')
  store = new ArtifactStore({ root })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('artifact store: immutable payload and scoped retrieval', () => {
  it('persists streamed bytes before metadata and reopens without host paths', async () => {
    async function* content() { yield 'hello '; yield Buffer.from('世界\n'); yield new Uint8Array([0, 1, 255]) }
    const expected = Buffer.concat([Buffer.from('hello 世界\n'), Buffer.from([0, 1, 255])])
    const metadata = await store.put({ actor, content: content(), mime: 'application/octet-stream', source: { kind: 'tool', toolCallId: 'call-1' } })
    assert.match(metadata.id, /^art_/)
    assert.equal(metadata.size, expected.length)
    assert.equal(metadata.sha256, createHash('sha256').update(expected).digest('hex'))
    assert.equal(JSON.stringify(metadata).includes(directory), false)
    const reopened = new ArtifactStore({ root })
    assert.deepEqual(await reopened.getMetadata({ actor, id: metadata.id }), metadata)
    let cursor, buffers = []
    do {
      const page = await reopened.read({ actor, id: metadata.id, cursor, limit: 3 })
      buffers.push(Buffer.from(page.data, page.encoding))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(Buffer.concat(buffers), expected)
    if (process.platform !== 'win32') {
      assert.equal((await stat(root)).mode & 0o777, 0o700)
      assert.equal((await stat(path.join(root, 'objects', `${metadata.id}.bin`))).mode & 0o777, 0o600)
    }
  })

  it('requires all actor fields and hides guessed IDs across each scope boundary', async () => {
    const metadata = await store.put({ actor, content: 'private' })
    for (const field of Object.keys(actor)) {
      const foreign = { ...actor, [field]: 'other' }
      for (const method of ['getMetadata', 'read', 'search', 'pin', 'delete', 'openDownload']) {
        await assert.rejects(store[method]({ actor: foreign, id: metadata.id, query: 'private' }), code('artifact_not_found'))
      }
      assert.equal((await store.list({ actor: foreign })).items.length, 0)
    }
    await assert.rejects(store.read({ actor: { accountId: actor.accountId }, id: metadata.id }), code('artifact_invalid'))
    await assert.rejects(store.read({ actor, id: '../catalog.json' }), code('artifact_invalid'))
  })

  it('binds cursors to artifact, content hash, query and list revision', async () => {
    const first = await store.put({ actor, content: 'abcabcabc' })
    const second = await store.put({ actor, content: 'abcabcabc' })
    const page = await store.read({ actor, id: first.id, limit: 1 })
    await assert.rejects(store.read({ actor, id: second.id, cursor: page.nextCursor }), code('artifact_cursor_stale'))
    const modified = JSON.parse(Buffer.from(page.nextCursor, 'base64url'))
    modified.sha256 = '0'.repeat(64)
    await assert.rejects(store.read({ actor, id: first.id, cursor: Buffer.from(JSON.stringify(modified)).toString('base64url') }), code('artifact_cursor_stale'))
    const search = await store.search({ actor, id: first.id, query: 'abc', maxBytes: 3 })
    await assert.rejects(store.search({ actor, id: first.id, query: 'bca', cursor: search.nextCursor }), code('artifact_cursor_stale'))
    const listed = await store.list({ actor, limit: 1 })
    await store.pin({ actor, id: first.id })
    await assert.rejects(store.list({ actor, cursor: listed.nextCursor }), code('artifact_cursor_stale'))
  })

  it('searches literal UTF-8 bytes across page boundaries with bounded results', async () => {
    const text = '123世界456世界789世界'
    const metadata = await store.put({ actor, content: text, mime: 'text/plain' })
    let cursor, matches = []
    do {
      const page = await store.search({ actor, id: metadata.id, query: '世界', maxBytes: 7, maxMatches: 1, cursor })
      matches.push(...page.matches.map(match => match.offset))
      assert.ok(page.scannedBytes <= 7)
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(matches, [3, 12, 21])
    await assert.rejects(store.search({ actor, id: metadata.id, query: '', maxBytes: 0 }), code('artifact_invalid'))
  })

  it('search matches seek directly to immutable tail bytes while retaining actor and snapshot checks', async () => {
    const tail = '尾部证据：真实恢复内容🙂\n', content = 'prefix '.repeat(20000) + tail
    const metadata = await store.put({ actor, content, mime: 'text/plain' })
    const found = await store.search({ actor, id: metadata.id, query: '尾部证据', maxBytes: 1024 * 1024 })
    assert.equal(found.matches.length, 1)
    const cursor = found.matches[0].readCursor
    const reopened = new ArtifactStore({ root })
    const page = await reopened.read({ actor, id: metadata.id, cursor, limit: 1024 })
    assert.equal(page.offset, Buffer.byteLength('prefix '.repeat(20000)))
    assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), tail)
    for (const field of Object.keys(actor)) await assert.rejects(reopened.read({ actor: { ...actor, [field]: 'other' }, id: metadata.id, cursor }), code('artifact_not_found'))
    const other = await store.put({ actor, content })
    await assert.rejects(reopened.read({ actor, id: other.id, cursor }), code('artifact_cursor_stale'))
    const changed = JSON.parse(Buffer.from(cursor, 'base64url')); changed.sha256 = '0'.repeat(64)
    await assert.rejects(reopened.read({ actor, id: metadata.id, cursor: Buffer.from(JSON.stringify(changed)).toString('base64url') }), code('artifact_cursor_stale'))
    await assert.rejects(reopened.search({ actor, id: metadata.id, query: '尾部证据', cursor }), code('artifact_cursor_stale'))
  })

  it('rejects JSON null, scalar and array cursors with classified Chinese errors', async () => {
    const metadata = await store.put({ actor, content: 'test' })
    for (const value of [null, true, 42, 'text', []]) {
      const cursor = Buffer.from(JSON.stringify(value)).toString('base64url')
      for (const method of ['read', 'search', 'list']) {
        await assert.rejects(store[method]({ actor, id: metadata.id, query: 'test', cursor }), code('artifact_invalid'))
      }
    }
  })

  it('returns a verified local handle without exposing paths and supports empty content', async () => {
    const metadata = await store.put({ actor, content: '' })
    const page = await store.read({ actor, id: metadata.id })
    assert.equal(page.data, '')
    assert.equal(page.nextCursor, null)
    const download = await store.openDownload({ actor, id: metadata.id })
    try { assert.equal((await download.handle.readFile()).length, 0) } finally { await download.handle.close() }
    assert.equal('path' in download, false)
  })

  it('keeps UTF-8 pages byte-exact and rejects unbounded or fractional read sizes', async () => {
    const content = '🙂文\u0000字é'.repeat(500)
    const metadata = await store.put({ actor, content, mime: 'text/plain; charset=utf-8' })
    let cursor, chunks = [], pageIndex = 0
    do {
      const page = await store.read({ actor, id: metadata.id, cursor, limit: [1, 13, 197, 255][pageIndex++ % 4] })
      assert.equal(page.encoding, 'base64')
      chunks.push(Buffer.from(page.data, 'base64'))
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(Buffer.concat(chunks).toString('utf8'), content)
    for (const limit of [0, -1, 0.5, 1024 * 1024 + 1, Infinity]) {
      await assert.rejects(store.read({ actor, id: metadata.id, limit }), code('artifact_invalid'))
    }
  })

  it('fixed allocation buckets return only requested bytes at every capacity boundary', async () => {
    const content = Buffer.alloc(1048581, 0x61)
    content.set(Buffer.from('tail!'), 1048576)
    const metadata = await store.put({ actor, content })
    let last
    for (const limit of [1, 4096, 4097, 65536, 65537, 262144, 262145, 1048576]) {
      const page = await store.read({ actor, id: metadata.id, limit })
      const decoded = Buffer.from(page.data, 'base64')
      assert.equal(decoded.length, limit, 'fixed-capacity padding must not enter a page')
      assert.deepEqual(decoded, content.subarray(0, limit))
      last = page
    }
    const tail = await store.read({ actor, id: metadata.id, cursor: last.nextCursor, limit: 1048576 })
    assert.equal(Buffer.from(tail.data, 'base64').toString('utf8'), 'tail!')
    assert.equal(tail.nextCursor, null)
    for (const limit of [1048577, Number.MAX_SAFE_INTEGER, Infinity, NaN, '1048576']) {
      await assert.rejects(store.read({ actor, id: metadata.id, limit }), code('artifact_invalid'))
    }
  })

  it('rejects source metadata carrying URLs, headers or arbitrary data', async () => {
    for (const source of [{ kind: 'web', url: 'https://example.test/?token=secret' }, { kind: 'tool', authorization: 'secret' }, { kind: 'unknown' }]) {
      await assert.rejects(store.put({ actor, content: 'x', source }), code('artifact_invalid'))
    }
  })
})

describe('artifact store: bounds, retention and failure behavior', () => {
  it('has documented quotas and validates configuration', () => {
    assert.equal(ARTIFACT_LIMITS.fileBytes, 128 * 1024 * 1024)
    assert.equal(ARTIFACT_LIMITS.runBytes, 1024 ** 3)
    assert.equal(ARTIFACT_LIMITS.deviceBytes, 10 * 1024 ** 3)
    assert.throws(() => new ArtifactStore({ root, limits: { pageBytes: 0 } }), code('artifact_invalid'))
    assert.throws(() => new ArtifactStore({ root, limits: { mystery: 1 } }), code('artifact_invalid'))
  })

  it('rejects oversized streams without publishing partial data', async () => {
    store = new ArtifactStore({ root, limits: { fileBytes: 5 } })
    let produced = 0
    async function* content() { produced++; yield '123'; produced++; yield '456'; produced++; yield 'never' }
    await assert.rejects(store.put({ actor, content: content() }), code('artifact_quota_exceeded'))
    assert.equal(produced, 2)
    assert.deepEqual((await store.list({ actor })).items, [])
    assert.deepEqual(await readdir(path.join(root, 'pending')), [])
    assert.deepEqual(await readdir(path.join(root, 'objects')), [])
  })

  it('enforces shared run quotas across sessions and device quotas across accounts', async () => {
    store = new ArtifactStore({ root, limits: { fileBytes: 10, runBytes: 8, deviceBytes: 12 } })
    await store.put({ actor, content: '12345' })
    await assert.rejects(store.put({ actor: { ...actor, sessionId: 'session-b' }, content: '6789' }), code('artifact_quota_exceeded'))
    await store.put({ actor: { ...actor, accountId: 'account-b' }, content: '67890' })
    await assert.rejects(store.put({ actor: { ...actor, accountId: 'account-c' }, content: 'abc' }), code('artifact_quota_exceeded'))
  })

  it('cancels a stream without retaining incomplete payloads', async () => {
    const controller = new AbortController()
    async function* content() { yield 'ok'; controller.abort(); yield 'not-published' }
    await assert.rejects(store.put({ actor, content: content(), signal: controller.signal }), { name: 'AbortError' })
    assert.equal((await store.list({ actor })).items.length, 0)
    assert.deepEqual(await readdir(path.join(root, 'pending')), [])
  })

  it('cancels even when an input iterator is stalled and releases its storage lock', { timeout: 5000 }, async () => {
    const controller = new AbortController()
    let requested
    const started = new Promise(resolve => { requested = resolve })
    const content = { [Symbol.asyncIterator]() { return { next() { requested(); return new Promise(() => {}) }, return() { return new Promise(() => {}) } } } }
    const pending = store.put({ actor, content, signal: controller.signal })
    await started
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal((await store.put({ actor, content: 'after cancellation' })).size, 18)
  })

  it('does not publish content when the producer throws', async () => {
    async function* content() { yield 'partial'; throw new Error('producer failed') }
    await assert.rejects(store.put({ actor, content: content() }), /producer failed/)
    assert.equal((await store.list({ actor })).items.length, 0)
    assert.deepEqual(await readdir(path.join(root, 'pending')), [])
  })

  it('quota rejection releases the lock even if producer teardown stalls before a later abort', { timeout: 5000 }, async () => {
    store = new ArtifactStore({ root, limits: { fileBytes: 1, lockTimeoutMs: 100 } })
    const controller = new AbortController()
    let returned = false
    const content = { [Symbol.asyncIterator]() { return {
      next() { return Promise.resolve({ done: false, value: 'too large' }) },
      return() { returned = true; return new Promise(() => {}) }
    } } }
    const timer = setTimeout(() => controller.abort(), 100)
    try {
      await assert.rejects(store.put({ actor, content, signal: controller.signal }), code('artifact_quota_exceeded'))
      assert.equal(returned, true)
      assert.deepEqual(await readdir(path.join(root, 'pending')), [])
      assert.equal((await store.put({ actor, content: 'x' })).size, 1)
    } finally { clearTimeout(timer) }
  })

  it('observes a failed producer teardown without masking quota errors or leaking the lock', async () => {
    store = new ArtifactStore({ root, limits: { fileBytes: 1 } })
    const content = { [Symbol.asyncIterator]() { return {
      next() { return Promise.resolve({ done: false, value: 'too large' }) },
      return() { return Promise.reject(new Error('teardown failed')) }
    } } }
    await assert.rejects(store.put({ actor, content }), code('artifact_quota_exceeded'))
    assert.equal((await store.put({ actor, content: 'x' })).size, 1)
  })

  it('only prunes resolved inactive unreferenced unpinned artifacts after TTL', async () => {
    let now = 1000
    store = new ArtifactStore({ root, clock: () => now, limits: { retentionMs: 100 } })
    const active = await store.put({ actor, content: 'active' })
    const unresolved = await store.put({ actor, content: 'unknown' })
    const pinned = await store.put({ actor, content: 'pinned' })
    const referenced = await store.put({ actor, content: 'referenced' })
    const eligible = await store.put({ actor, content: 'eligible' })
    await store.setRetention({ actor, id: unresolved.id, active: false })
    for (const entry of [pinned, referenced, eligible]) await store.setRetention({ actor, id: entry.id, active: false, resolved: true })
    await store.pin({ actor, id: pinned.id })
    await store.setRetention({ actor, id: referenced.id, references: ['receipt-1'] })
    for (const entry of [active, unresolved, pinned, referenced]) await assert.rejects(store.delete({ actor, id: entry.id }), code('artifact_retained'))
    assert.deepEqual((await store.prune({ actor })).removed, [])
    now += 101
    assert.deepEqual((await store.prune({ actor })).removed, [eligible.id])
    assert.equal((await store.list({ actor })).items.length, 4)
    await assert.rejects(store.getMetadata({ actor, id: eligible.id }), code('artifact_not_found'))
  })

  it('detects missing and same-sized tampered payloads instead of claiming completeness', async () => {
    const first = await store.put({ actor, content: 'original' })
    const file = path.join(root, 'objects', `${first.id}.bin`)
    await store.getMetadata({ actor, id: first.id }) // Populate verified-snapshot cache.
    await writeFile(file, 'modified')
    await assert.rejects(store.getMetadata({ actor, id: first.id }), code('artifact_corrupt'))
    await unlink(file)
    await assert.rejects(store.read({ actor, id: first.id }), code('artifact_missing'))
  })

  it('fails closed on malformed or missing catalogs and never replaces them', async () => {
    await store.put({ actor, content: 'evidence' })
    const file = path.join(root, 'catalog.json')
    await writeFile(file, '{corrupt')
    await assert.rejects(store.put({ actor, content: 'new' }), code('artifact_corrupt'))
    assert.equal(await readFile(file, 'utf8'), '{corrupt')
    await unlink(file)
    await assert.rejects(store.list({ actor }), code('artifact_corrupt'))
  })

  it('counts orphan payloads left by an interrupted commit against device quota', async () => {
    store = new ArtifactStore({ root, limits: { deviceBytes: 10 } })
    const metadata = await store.put({ actor, content: '12345678' })
    const catalogPath = path.join(root, 'catalog.json')
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
    delete catalog.records[metadata.id]
    await writeFile(catalogPath, JSON.stringify(catalog))
    await assert.rejects(store.put({ actor, content: '456' }), code('artifact_quota_exceeded'))
  })

  it('rejects symlinked roots, files and lock entries', { skip: process.platform === 'win32' }, async () => {
    const metadata = await store.put({ actor, content: 'evidence' })
    const target = path.join(directory, 'elsewhere')
    await mkdir(target, { mode: 0o700 })
    const alternate = path.join(directory, 'linked-root')
    await symlink(target, alternate)
    assert.throws(() => new ArtifactStore({ root: alternate }), code('artifact_unsafe_storage'))
    const payload = path.join(root, 'objects', `${metadata.id}.bin`)
    const outside = path.join(directory, 'external.bin')
    await writeFile(outside, 'evidence', { mode: 0o600 })
    await unlink(payload)
    await symlink(outside, payload)
    await assert.rejects(store.read({ actor, id: metadata.id }), code('artifact_unsafe_storage'))
    await symlink(outside, path.join(root, 'catalog.lock'))
    await assert.rejects(store.list({ actor }), code('artifact_unsafe_storage'))
  })

  it('rejects broadly readable files and hardlinked payloads', { skip: process.platform === 'win32' }, async () => {
    const metadata = await store.put({ actor, content: 'evidence' })
    const file = path.join(root, 'objects', `${metadata.id}.bin`)
    await chmod(file, 0o644)
    await assert.rejects(store.read({ actor, id: metadata.id }), code('artifact_unsafe_storage'))
    await chmod(file, 0o600)
    await link(file, path.join(directory, 'hardlink.bin'))
    await assert.rejects(store.read({ actor, id: metadata.id }), code('artifact_unsafe_storage'))
  })

  it('canonicalizes trusted OS parent aliases but still rejects a swapped store root', { skip: process.platform === 'win32' }, async () => {
    const parent = path.join(directory, 'real-parent')
    const alias = path.join(directory, 'parent-alias')
    await mkdir(parent, { mode: 0o700 })
    await symlink(parent, alias)
    const throughAlias = new ArtifactStore({ root: path.join(alias, 'data') })
    const metadata = await throughAlias.put({ actor, content: 'trusted parent alias' })
    assert.equal((await new ArtifactStore({ root: path.join(parent, 'data') }).getMetadata({ actor, id: metadata.id })).size, 20)
    const swappedRoot = path.join(directory, 'swapped-root')
    const beforeSwap = new ArtifactStore({ root: swappedRoot })
    await symlink(parent, swappedRoot)
    await assert.rejects(beforeSwap.list({ actor }), code('artifact_unsafe_storage'))
  })
})

describe('artifact store: concurrency', () => {
  it('serializes independent instances and retains every published artifact', async () => {
    const writers = Array.from({ length: 12 }, () => new ArtifactStore({ root }))
    const entries = await Promise.all(writers.map((writer, i) => writer.put({ actor, content: `payload-${i}` })))
    const listed = await store.list({ actor })
    assert.equal(listed.items.length, writers.length)
    assert.equal(new Set(listed.items.map(entry => entry.id)).size, writers.length)
    for (const entry of entries) assert.equal((await store.getMetadata({ actor, id: entry.id })).sha256, entry.sha256)
  })

  it('enforces quotas between independent processes', async () => {
    const moduleUrl = new URL('../src/storage/artifact-store.mjs', import.meta.url).href
    const program = `
      import { ArtifactStore } from ${JSON.stringify(moduleUrl)};
      const store = new ArtifactStore({ root: process.argv[1], limits: { fileBytes: 8, runBytes: 8, deviceBytes: 8 } });
      try { await store.put({ actor: ${JSON.stringify(actor)}, content: '123456' }); process.stdout.write('ok'); }
      catch (error) { process.stdout.write(error.code || error.message); process.exitCode = error.code === 'artifact_quota_exceeded' ? 0 : 1; }
    `
    const results = await Promise.all(Array.from({ length: 4 }, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', errors = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { errors += chunk })
      const [exit] = await once(child, 'close')
      assert.equal(exit, 0, errors || output)
      return output
    }))
    assert.equal(results.filter(value => value === 'ok').length, 1)
    assert.equal(results.filter(value => value === 'artifact_quota_exceeded').length, 3)
    assert.equal((await store.list({ actor })).items.length, 1)
  })

  it('recovers a dead upload lock but retains and charges uncommitted bytes', { timeout: 10000 }, async () => {
    const moduleUrl = new URL('../src/storage/artifact-store.mjs', import.meta.url).href
    const coverageUrl = new URL('./helpers/crash-coverage.mjs', import.meta.url).href
    const program = `
      import { ArtifactStore } from ${JSON.stringify(moduleUrl)};
      import { checkpointCrashCoverage } from ${JSON.stringify(coverageUrl)};
      const keepAlive = setInterval(() => {}, 1000);
      const store = new ArtifactStore({ root: process.argv[1] });
      async function* content() { yield '123456'; checkpointCrashCoverage(); process.stdout.write('ready'); await new Promise(() => {}); }
      await store.put({ actor: ${JSON.stringify(actor)}, content: content() });
      clearInterval(keepAlive);
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    try {
      await once(child.stdout, 'data')
      child.kill('SIGKILL')
      await closed
      store = new ArtifactStore({ root, limits: { fileBytes: 8, runBytes: 8, deviceBytes: 8 } })
      await assert.rejects(store.put({ actor, content: 'abc' }), code('artifact_quota_exceeded'))
      assert.equal((await store.list({ actor })).items.length, 0)
      assert.equal((await readdir(path.join(root, 'pending'))).length, 1)
      assert.equal((await store.put({ actor, content: 'ok' })).size, 2)
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    }
  })
})
