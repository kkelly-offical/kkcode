import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ReplayStore } from '../src/device/replay-store.mjs'
import { RequestLedger, REQUEST_WINDOW_MS } from '../src/device/request-ledger.mjs'
import { ProtocolError } from '../src/protocol/index.mjs'
import { DeviceService } from '../src/device/service.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-retention-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const event = (sessionId = 'session', text = 'hello') => ({ sessionId, type: 'text.delta', payload: { text } })
const savedRow = (seq, fields = {}) => ({ ...event(), schemaVersion: '1', id: `event-${seq}`, seq, timestamp: 100, ...fields })
const journalBytes = async directory => (await Promise.all((await readdir(directory)).filter(name => /^events-.*\.jsonl$/.test(name)).map(async name => (await stat(path.join(directory, name))).size))).reduce((sum, bytes) => sum + bytes, 0)

test('replay serializes concurrent reads/appends, bounds count and preserves cursors through rotation/restart', async t => {
  const directory = await fixture(t), store = await new ReplayStore(directory, { maxEvents: 3 }).initialize()
  const work = []
  for (let i = 0; i < 10; i++) { work.push(store.append(event())); work.push(store.read('session', i)) }
  const results = await Promise.all(work)
  assert.deepEqual(results.filter((_, i) => i % 2 === 0).map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const replay = await store.read('session', 7)
  assert.equal(replay.gap, false); assert.equal(replay.earliest, 8); assert.equal(replay.cursor, 10)
  assert.deepEqual(replay.events.map(row => row.seq), [8, 9, 10])
  assert.equal((await store.read('session', 0)).gap, true)
  assert.equal(await journalBytes(directory), store.stats().bytes)
  const restarted = await new ReplayStore(directory, { maxEvents: 3 }).initialize()
  assert.equal((await restarted.append(event())).seq, 11)
  assert.equal((await restarted.read('session', 10)).gap, false)
})

test('replay per-session and global byte bounds include UTF8/newlines, with deterministic oldest-journal eviction', async t => {
  const directory = await fixture(t), store = await new ReplayStore(directory, { sessionBytes: 650, totalBytes: 800 }).initialize()
  for (const sessionId of ['old', 'middle', 'new']) for (let i = 0; i < 4; i++) await store.append(event(sessionId, '界'.repeat(100)))
  assert.ok(store.stats().bytes <= 800)
  for (const name of (await readdir(directory)).filter(name => name.startsWith('events-'))) assert.ok((await stat(path.join(directory, name))).size <= 650)
  assert.equal(await journalBytes(directory), store.stats().bytes)
  assert.equal((await store.read('old', 0)).gap, true)
  assert.ok((await store.read('new', 3)).events.length > 0)
})

test('age pruning and cursor-only startup cannot reset sequence numbers or delete canonical history', async t => {
  const directory = await fixture(t); let now = 100
  const canonical = path.join(directory, 'canonical-history.json'); await writeFile(canonical, 'never delete this conversation')
  const store = await new ReplayStore(directory, { now: () => now, maxAgeMs: 10 }).initialize()
  await store.append(event()); now += 11
  const empty = await store.read('session', 0)
  assert.equal(empty.cursor, 1); assert.equal(empty.earliest, 2); assert.equal(empty.gap, true); assert.deepEqual(empty.events, [])
  await rm(store.file('session'))
  const restarted = await new ReplayStore(directory, { now: () => now, maxAgeMs: 10 }).initialize()
  assert.equal((await restarted.read('session', 1)).gap, false)
  assert.equal((await restarted.append(event())).seq, 2)
  assert.equal(await readFile(canonical, 'utf8'), 'never delete this conversation')
})

test('gaps include corrupt/missing tail, skipped UTF8 oversized events and snapshot placeholders', async t => {
  const directory = await fixture(t)
  await writeFile(path.join(directory, 'cursor-session.json'), JSON.stringify({ cursor: 4 }))
  await writeFile(path.join(directory, 'events-session.jsonl'), [savedRow(1, { payload: { text: '界'.repeat(80) } }), savedRow(3)].map(JSON.stringify).join('\n') + '\nnot-json\n')
  const store = await new ReplayStore(directory, { now: () => 100, maxEventBytes: 250 }).initialize()
  assert.deepEqual((await store.read('session', 0)).events.map(row => row.seq), [3])
  assert.equal((await store.read('session', 3)).gap, true)
  assert.equal((await store.read('session', 4)).gap, false)
  assert.equal((await store.read('session', 5)).gap, true)
  const marker = await store.append(event('session', 'a'.repeat(1000)))
  assert.equal(marker.type, 'replay.snapshot_required')
  assert.equal((await store.read('session', 4)).gap, true)
  assert.ok((await store.read('session', 4)).events.every(row => Buffer.byteLength(JSON.stringify(row)) + 1 <= 250))
})

test('pagination does not falsely flag unseen later pages; interior gaps are reported on their page', async t => {
  const directory = await fixture(t)
  await writeFile(path.join(directory, 'events-session.jsonl'), [savedRow(1), savedRow(3), savedRow(4)].map(JSON.stringify).join('\n') + '\n')
  const store = await new ReplayStore(directory, { now: () => 100 }).initialize()
  assert.equal((await store.read('session', 0, 1)).gap, false)
  assert.equal((await store.read('session', 1, 1)).gap, true)
  assert.equal((await store.read('session', 3, 1)).gap, false)
  await assert.rejects(store.read('session', -1), { code: 'invalid_cursor' })
  await assert.rejects(store.read('session', 0, 0), { code: 'invalid_limit' })
  await assert.rejects(store.read('../outside'), { code: 'invalid_session' })
})

test('a snapshot placeholder cannot itself overflow a tiny configured event cap', async t => {
  const directory = await fixture(t), store = await new ReplayStore(directory, { maxEventBytes: 32 }).initialize()
  assert.equal((await store.append(event())).type, 'replay.snapshot_required')
  assert.equal(store.stats().bytes, 0)
  assert.equal((await store.read('session', 0)).gap, true)
  assert.equal((await new ReplayStore(directory, { maxEventBytes: 32 }).initialize()).stats().bytes, 0)
})

test('aggregate replay responses respect their byte budget without turning normal pagination into a gap', async t => {
  const directory = await fixture(t), store = await new ReplayStore(directory, { maxResponseBytes: 550 }).initialize()
  for (let i = 0; i < 8; i++) await store.append(event())
  const collected = []; let after = 0
  while (after < 8) {
    const page = await store.read('session', after)
    assert.equal(page.gap, false); assert.equal(page.cursor, 8)
    assert.ok(page.events.length > 0 && page.events.length < 8)
    assert.ok(Buffer.byteLength(JSON.stringify(page.events)) <= 550)
    collected.push(...page.events); after = page.events.at(-1).seq
  }
  assert.deepEqual(collected.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  const tiny = await new ReplayStore(directory, { maxResponseBytes: 32 }).initialize()
  assert.equal((await tiny.read('session', 0)).gap, true)
  assert.deepEqual((await tiny.read('session', 0)).events, [])
})

test('failed appends reserve a cursor without ghost rows and subsequent appends recover', async t => {
  const directory = await fixture(t), store = await new ReplayStore(directory).initialize()
  await store.read('session')
  await mkdir(store.file('session'))
  await assert.rejects(store.append(event()))
  const afterFailure = await store.read('session')
  assert.equal(afterFailure.cursor, 1); assert.equal(afterFailure.gap, true); assert.deepEqual(afterFailure.events, [])
  await rm(store.file('session'), { recursive: true })
  assert.equal((await store.append(event())).seq, 2)
  const restarted = await new ReplayStore(directory).initialize()
  assert.equal((await restarted.read('session', 1)).gap, false)
  assert.equal((await restarted.read('session', 0)).gap, true)
})

test('a failed quota rotation cannot admit new bytes or pretend it freed an old journal', async t => {
  const directory = await fixture(t), store = await new ReplayStore(directory, { totalBytes: 250 }).initialize()
  await store.append(event('old'))
  const original = await readFile(store.file('old')), used = store.stats().bytes
  await rm(store.file('old')); await mkdir(store.file('old'))
  await assert.rejects(store.append(event('new')))
  assert.equal(store.stats().bytes, used)
  assert.equal((await store.read('new', 0)).cursor, 0)
  await assert.rejects(stat(store.file('new')), { code: 'ENOENT' })
  await rm(store.file('old'), { recursive: true }); await writeFile(store.file('old'), original)
  await store.append(event('new'))
  assert.ok(store.stats().bytes <= 250)
  assert.equal(await journalBytes(directory), store.stats().bytes)
})

test('age pruning handles non-monotonic clocks and invalid high-water marks fail closed', async t => {
  const directory = await fixture(t)
  await writeFile(path.join(directory, 'events-session.jsonl'), [savedRow(1), savedRow(2, { timestamp: 1 })].map(JSON.stringify).join('\n') + '\n')
  const store = await new ReplayStore(directory, { now: () => 110, maxAgeMs: 50 }).initialize()
  assert.deepEqual((await store.read('session')).events.map(row => row.seq), [1])
  assert.equal((await store.read('session', 1)).gap, true)
  await writeFile(path.join(directory, 'cursor-session.json'), JSON.stringify({ cursor: -1 }))
  await assert.rejects(new ReplayStore(directory).initialize(), /high-water/)
})

test('request results and protocol errors remain retryable for at least15minutes, even with shorter configured TTL', async t => {
  const directory = await fixture(t); let now = 0
  const ledger = await new RequestLedger(path.join(directory, 'requests.json'), { now: () => now, maxEntries: 2, maxAgeMs: 1 }).initialize()
  await ledger.reserve('owner:a', 'hash-a'); await ledger.complete('owner:a', { accepted: true })
  await ledger.reserve('owner:b', 'hash-b'); await ledger.fail('owner:b', new ProtocolError('forbidden', 'Owner required', 403))
  now = REQUEST_WINDOW_MS
  assert.throws(() => ledger.reserve('owner:c', 'hash-c'), { code: 'idempotency_capacity' })
  assert.deepEqual(ledger.get('owner:a').result, { accepted: true })
  assert.equal(ledger.get('owner:b').state, 'failed'); assert.equal(ledger.get('owner:b').error.status, 403)
  now++
  await ledger.reserve('owner:c', 'hash-c')
  assert.equal(ledger.get('owner:a'), undefined); assert.equal(ledger.get('owner:b'), undefined)
})

test('long-running requests get a complete retry window after their final result', async t => {
  const directory = await fixture(t); let now = 0
  const ledger = await new RequestLedger(path.join(directory, 'requests.json'), { now: () => now, maxEntries: 1 }).initialize()
  await ledger.reserve('long', 'hash'); now = 2 * REQUEST_WINDOW_MS; await ledger.complete('long', 'finished')
  assert.throws(() => ledger.reserve('new', 'hash'), { code: 'idempotency_capacity' })
  now += REQUEST_WINDOW_MS + 1
  await ledger.reserve('new', 'hash')
  assert.equal(ledger.get('long'), undefined)
})

test('uncertain/running requests survive all retention pressure and restart conversion', async t => {
  const directory = await fixture(t), file = path.join(directory, 'requests.json'); let now = 0
  const ledger = await new RequestLedger(file, { now: () => now, maxEntries: 1 }).initialize()
  await ledger.reserve('side-effect', 'hash')
  now = 30 * 86400000
  const restarted = await new RequestLedger(file, { now: () => now, maxEntries: 1 }).initialize()
  assert.equal(restarted.get('side-effect').state, 'unknown')
  assert.throws(() => restarted.reserve('another', 'hash'), { code: 'idempotency_capacity' })
  assert.equal(restarted.stats().uncertain, 1)
  assert.equal(JSON.parse(await readFile(file, 'utf8'))['side-effect'].state, 'unknown')
})

test('concurrent completion cannot spend other requests failure headroom; every persisted snapshot stays bounded', async t => {
  const directory = await fixture(t), file = path.join(directory, 'requests.json')
  const ledger = await new RequestLedger(file, { maxBytes: 1600 }).initialize()
  await Promise.all([ledger.reserve('a', 'hash-a'), ledger.reserve('b', 'hash-b')])
  await Promise.all([ledger.complete('a', 'x'.repeat(1100)), ledger.fail('b', new ProtocolError('known_failure', '界'.repeat(1000), 409))])
  assert.equal(ledger.get('a').omitted, true)
  assert.equal(Object.hasOwn(ledger.get('a'), 'result'), false)
  assert.equal(ledger.get('b').state, 'failed')
  assert.ok(ledger.get('b').error.message.length < 1000)
  assert.ok(ledger.stats().bytes <= 1600); assert.ok((await stat(file)).size <= 1600)
  const restored = await new RequestLedger(file, { maxBytes: 1600 }).initialize()
  assert.equal(restored.get('a').omitted, true); assert.equal(restored.get('b').state, 'failed')
})

test('oversized results explicitly omit their retry payload; unexpected errors remain unknown', async t => {
  const directory = await fixture(t), ledger = await new RequestLedger(path.join(directory, 'requests.json'), { maxResultBytes: 10 }).initialize()
  await ledger.reserve('a', 'h'); await ledger.complete('a', { text: 'too large for journal' })
  assert.deepEqual({ state: ledger.get('a').state, omitted: ledger.get('a').omitted }, { state: 'done', omitted: true })
  await ledger.reserve('b', 'h'); await ledger.fail('b', new Error('could have written a file'))
  assert.equal(ledger.get('b').state, 'unknown')
  assert.throws(() => ledger.reserve('b', 'h'), { code: 'request_conflict' })
})

test('failure headroom remains byte-exact after a clock jump and non-finite limits are rejected', async t => {
  const directory = await fixture(t); let now = 0
  const ledger = await new RequestLedger(path.join(directory, 'requests.json'), { now: () => now }).initialize()
  await ledger.reserve('edge', 'hash'); ledger.limits.maxBytes = ledger.stats().reservedBytes
  now = 9000000000000
  await ledger.fail('edge', new ProtocolError('known', '界'.repeat(1000), 409))
  assert.ok(ledger.stats().bytes <= ledger.limits.maxBytes)
  assert.throws(() => new RequestLedger('unused', { maxBytes: Infinity }), /journal limit/)
  assert.throws(() => new ReplayStore('unused', { totalBytes: NaN }), /replay limit/)
})

test('journal initialization does not over-evict at the exact count cap and rejects malformed entries', async t => {
  const directory = await fixture(t), file = path.join(directory, 'requests.json'); let now = 0
  const ledger = await new RequestLedger(file, { now: () => now, maxEntries: 2 }).initialize()
  await ledger.reserve('a', 'h'); await ledger.complete('a', 1)
  await ledger.reserve('b', 'h'); await ledger.complete('b', 2)
  now = REQUEST_WINDOW_MS + 1
  const restarted = await new RequestLedger(file, { now: () => now, maxEntries: 2 }).initialize()
  assert.equal(restarted.stats().entries, 2)
  await writeFile(file, '{"bad":null}')
  await assert.rejects(new RequestLedger(file).initialize(), /journal entry/)
})

test('idempotency map has no inherited keys and legacy entries without timestamps receive a protected window', async t => {
  const directory = await fixture(t), file = path.join(directory, 'requests.json')
  await writeFile(file, JSON.stringify({ legacy: { hash: 'h', state: 'done', result: 1 } }))
  const ledger = await new RequestLedger(file, { now: () => 123 }).initialize()
  assert.equal(ledger.get('legacy').at, 123)
  assert.equal(ledger.get('__proto__'), undefined)
  await ledger.reserve('__proto__', 'h'); await ledger.complete('__proto__', 2)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).__proto__.result, 2)
  assert.throws(() => ledger.reserve('', 'hash'), { code: 'invalid_request_key' })
})

test('device retries reproduce known errors and reject omitted results without executing twice', async t => {
  const directory = await fixture(t), priorHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(directory, 'private-state')
  const service = await new DeviceService({ cwd: directory, roots: [directory], retention: { requests: { maxResultBytes: 16 } } }).initialize()
  try {
    let executions = 0
    service.dispatch = async (_method, params) => {
      executions++
      if (params.kind === 'known') throw new ProtocolError('rejected_by_policy', 'Not allowed', 403)
      if (params.kind === 'unexpected') throw new Error('Uncertain outcome')
      return { text: 'large result is intentionally absent from the replay journal' }
    }
    const large = { id: 'large', method: 'sessions.create' }
    await service.request(large)
    await assert.rejects(service.request(large), { code: 'result_expired' })
    assert.equal(executions, 1)
    const known = { id: 'known', method: 'sessions.create', params: { kind: 'known' } }
    for (let i = 0; i < 2; i++) await assert.rejects(service.request(known), { code: 'rejected_by_policy', status: 403 })
    assert.equal(executions, 2)
    const unexpected = { id: 'unexpected', method: 'sessions.create', params: { kind: 'unexpected' } }
    await assert.rejects(service.request(unexpected), /Uncertain outcome/)
    await assert.rejects(service.request(unexpected), { code: 'outcome_unknown' })
    assert.equal(executions, 3)
    await assert.rejects(service.request({ id: 'expired', method: 'sessions.create', issuedAt: Date.now() - REQUEST_WINDOW_MS - 1 }), { code: 'request_expired' })
    assert.equal(executions, 3)
  } finally {
    await service.close()
    if (priorHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = priorHome
  }
})
