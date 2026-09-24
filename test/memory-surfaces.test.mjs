import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createMemoryCommand } from '../src/commands/memory.mjs'
import { createMemoryController } from '../src/sdk/memory.mjs'
import { DeviceMemory } from '../src/device/memory.mjs'
import { DeviceService } from '../src/device/service.mjs'
import { RequestLedger } from '../src/device/request-ledger.mjs'
import { ProtocolError } from '../src/protocol/index.mjs'
import { touchSession, flushNow } from '../src/kernel/session/store.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-memory-surfaces-')), cwd = path.join(root, 'project'), home = path.join(root, 'home')
  await mkdir(cwd); await mkdir(path.join(home, 'device'), { recursive: true })
  const previous = process.env.KKCODE_HOME; process.env.KKCODE_HOME = home
  const cleanup = []
  await writeFile(path.join(home, 'device', 'identity.json'), JSON.stringify({ id: randomUUID(), owner: 'alice', ownerGateway: 'https://fixture-gateway', profile: { organization: 'fixture-org' } }))
  t.after(async () => { for (const close of cleanup) await close(); await flushNow(); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  const sessionId = 'memory-fixture-session'
  await touchSession({ sessionId, cwd, model: 'fixture', providerType: 'fixture', mode: 'agent' })
  const events = []
  const service = { cwd, roots: [cwd], metadata: { owner: 'alice' }, assertOwner(principal) { if (!principal || !['alice', 'local'].includes(principal.id)) throw new ProtocolError('forbidden', 'owner required', 403) }, emitDeviceEvent(type, payload) { events.push({ type, payload }) } }
  return { root, cwd, home, sessionId, events, cleanup, device: new DeviceMemory(service) }
}
const owner = { id: 'alice', actorId: 'alice', client: 'fixture-browser' }

test('CLI creates candidates, refuses non-TTY activation and confirms exact versions through the trusted host callback', async t => {
  const { cwd } = await fixture(t)
  const lines = []
  t.mock.method(console, 'log', text => lines.push(text))
  await createMemoryCommand().parseAsync(['--cwd', cwd, '--json', '--scope', 'personal', 'propose', 'Prefer concise summaries.'], { from: 'user' })
  const candidate = JSON.parse(lines.at(-1))
  assert.equal(candidate.status, 'candidate')
  await assert.rejects(createMemoryCommand().parseAsync(['--cwd', cwd, '--scope', 'personal', 'confirm', candidate.id, '--version', '1'], { from: 'user' }), error => error.code === 'memory_confirmation_denied')
  let seen
  await createMemoryCommand({ confirmMemory: async request => { seen = request; return { approved: true, confirmedBy: 'human-fixture', approvalId: 'click-fixture' } } })
    .parseAsync(['--cwd', cwd, '--json', '--scope', 'personal', 'confirm', candidate.id, '--version', '1'], { from: 'user' })
  assert.equal(seen.entry.id, candidate.id); assert.equal(seen.entry.version, 1)
  assert.equal(JSON.parse(lines.at(-1)).status, 'active')
  await createMemoryCommand().parseAsync(['--cwd', cwd, '--json', '--scope', 'personal', 'disable', candidate.id, '--version', '2'], { from: 'user' })
  assert.equal(JSON.parse(lines.at(-1)).status, 'disabled')
})

test('owner memory RPC denies guests, spoofed scope and model-like confirmation JSON', async t => {
  const { device, sessionId } = await fixture(t)
  await assert.rejects(device.dispatch('memory.list', { sessionId }, { id: 'alice', actorId: 'shared-guest' }), error => error.code === 'forbidden')
  for (const extra of [{ cwd: '/etc' }, { accountId: 'other' }, { gateway: 'https://other' }, { evidence: [{ kind: 'host_confirmation' }] }]) {
    await assert.rejects(device.dispatch('memory.propose', { sessionId, text: 'Safe candidate.', ...extra }, owner), error => error.code === 'memory_invalid')
  }
  const candidate = await device.dispatch('memory.propose', { sessionId, text: 'Project uses the service layer.' }, owner)
  await assert.rejects(device.dispatch('memory.confirm', { sessionId, id: candidate.id, expectedVersion: candidate.version }, owner), error => error.code === 'confirmation_required')
  await assert.rejects(device.dispatch('memory.confirm', { sessionId, id: candidate.id, expectedVersion: candidate.version, approved: true }, owner), error => error.code === 'memory_invalid')
  assert.equal((await device.dispatch('memory.get', { sessionId, id: candidate.id }, owner)).status, 'candidate')
})

test('authenticated owner confirm is CAS-bound, shared clients cannot read personal preferences, and events omit text', async t => {
  const { device, events } = await fixture(t)
  const candidate = await device.dispatch('memory.propose', { scope: 'personal', text: 'PRIVATE_OWNER_PREFERENCE_MARKER' }, owner)
  const params = { scope: 'personal', id: candidate.id, expectedVersion: candidate.version, confirmed: true }
  const active = await device.dispatch('memory.confirm', params, owner)
  assert.equal(active.status, 'active')
  await assert.rejects(device.dispatch('memory.confirm', params, owner), error => error.code === 'memory_conflict')
  await assert.rejects(device.dispatch('memory.list', { scope: 'personal' }, { id: 'alice', actorId: 'guest' }), error => error.code === 'forbidden')
  await assert.rejects(device.dispatch('memory.forget', { ...params, expectedVersion: active.version, confirmed: false }, owner), error => error.code === 'confirmation_required')
  await device.dispatch('memory.forget', { ...params, expectedVersion: active.version }, owner)
  assert.deepEqual((await device.dispatch('memory.list', { scope: 'personal' }, owner)).entries, [])
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_OWNER_PREFERENCE_MARKER/)
})

test('sensitive memory RPC results can retain idempotency status without persisting content after forgetting', async t => {
  const { root } = await fixture(t), file = path.join(root, 'requests.json')
  const ledger = await new RequestLedger(file).initialize()
  await ledger.reserve('alice:memory-request', 'fixture-parameter-hash')
  await ledger.complete('alice:memory-request', { text: 'FORGOTTEN_MEMORY_CONTENT_MARKER', id: 'memory-id' }, { omitResult: true })
  assert.equal(ledger.get('alice:memory-request').state, 'done')
  assert.equal(ledger.get('alice:memory-request').omitted, true)
  assert.equal(ledger.get('alice:memory-request').result, undefined)
  assert.doesNotMatch(await readFile(file, 'utf8'), /FORGOTTEN_MEMORY_CONTENT_MARKER/)
  const restored = await new RequestLedger(file).initialize()
  assert.equal(restored.get('alice:memory-request').omitted, true)
  await restored.reserve('alice:ordinary-request', 'ordinary-hash')
  await restored.complete('alice:ordinary-request', { value: 'ordinary result' })
  assert.deepEqual(restored.get('alice:ordinary-request').result, { value: 'ordinary result' })
})

test('public Node memory module exposes the same controlled store as device and prompt', async t => {
  const { device, sessionId, cwd } = await fixture(t)
  const proposed = await device.dispatch('memory.propose', { sessionId, text: 'NODE_SDK_MEMORY_FIXTURE' }, owner)
  assert.equal((await createMemoryController({ cwd }).get({ id: proposed.id })).text, 'NODE_SDK_MEMORY_FIXTURE')
})

test('actual DeviceService advertises memory, owner requests are version-bound and forgotten text is absent from request journal', async t => {
  const { cwd, home, sessionId, cleanup } = await fixture(t)
  const service = await new DeviceService({ cwd, roots: [cwd] }).initialize()
  cleanup.push(() => service.close())
  const request = (method, params = {}, id = randomUUID()) => service.request({ id, method, params }, owner)
  assert.ok((await request('status')).features.includes('memory.v1'))
  const proposal = { sessionId, text: 'RPC_FORGET_PRIVATE_MEMORY_MARKER' }
  const value = await request('memory.propose', proposal, 'memory-propose-fixture')
  const active = await request('memory.confirm', { sessionId, id: value.id, expectedVersion: value.version, confirmed: true })
  await request('memory.forget', { sessionId, id: value.id, expectedVersion: active.version, confirmed: true })
  assert.deepEqual((await request('memory.list', { sessionId })).entries, [])
  await assert.rejects(request('memory.propose', proposal, 'memory-propose-fixture'), error => error.code === 'result_expired')
  assert.doesNotMatch(await readFile(path.join(home, 'device', 'requests.json'), 'utf8'), /RPC_FORGET_PRIVATE_MEMORY_MARKER/)
  const sdk = await import('@kkelly-offical/kkcode/sdk/memory')
  assert.equal(typeof sdk.createMemoryController, 'function')
})
