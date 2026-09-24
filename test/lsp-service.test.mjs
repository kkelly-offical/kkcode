import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, rename, unlink, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createLanguageService, createLspTools, LSP_LANGUAGES } from '../src/kernel/lsp/service.mjs'

const server = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const hostRead = { skip: process.platform !== 'linux' }
async function fixture(t, flags = [], options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kk-lsp-service-'))
  await writeFile(path.join(cwd, 'app.ts'), 'export const sample = 1\n')
  const service = await createLanguageService({ cwd, mode: 'host', timeoutMs: 1500,
    servers: { typescript: { command: process.execPath, args: [server, ...flags] } }, authorizeStart: async () => true, ...options })
  t.after(async () => { service.close(); await rm(cwd, { recursive: true, force: true }) })
  return { service, cwd }
}

test('language service is lazy; diagnostics/symbols/definition/reference use real framed subprocesses', hostRead, async t => {
  const { service, cwd } = await fixture(t, ['--fragment'])
  assert.equal(service.status().running, 0)
  assert.deepEqual(LSP_LANGUAGES, ['typescript', 'javascript', 'python', 'go', 'kotlin'])
  const result = await service.inspect({ operation: 'diagnostics', path: 'app.ts' })
  assert.equal(result.items[0].message, 'synthetic diagnostic')
  assert.equal(result.diagnosticMode, 'pull_full')
  assert.equal(result.isolation.strict, false)
  assert.equal(result.sourceHash.length, 64)
  const symbols = await service.inspect({ operation: 'symbols', path: 'app.ts' })
  assert.equal(symbols.items[0].name, 'readOnlySymbol', 'server applyEdit request was rejected')
  for (const operation of ['definition', 'references']) {
    const locations = await service.inspect({ operation, path: 'app.ts', line: 0, character: 1 })
    assert.equal(locations.items.length, 1)
    assert.equal(locations.items[0].path, 'app.ts')
    assert.equal(locations.filteredLocations, 1)
  }
  const [tool] = createLspTools()
  assert.equal(JSON.parse((await tool.execute({ operation: 'symbols', path: 'app.ts' }, { lspService: service, cwd })).output).items[0].name, 'readOnlySymbol')
  await assert.rejects(tool.execute({ operation: 'symbols', path: 'app.ts' }, { lspService: { inspect: () => ({}) }, cwd }), { code: 'LSP_HOST_REQUIRED' })
})

test('push-only diagnostics are labeled snapshots and stale notifications do not pass as clean', hostRead, async t => {
  const valid = await fixture(t, ['--push', '--require-push-capability'])
  assert.equal((await valid.service.inspect({ operation: 'diagnostics', path: 'app.ts' })).diagnosticMode, 'push_snapshot')
  const stale = await fixture(t, ['--push', '--stale'], { timeoutMs: 200 })
  await assert.rejects(stale.service.inspect({ operation: 'diagnostics', path: 'app.ts' }), { code: 'LSP_TIMEOUT' })
})

test('advertised TypeScript read-only barriers do not confuse an initial empty push with completed diagnostics', hostRead, async t => {
  const valid = await fixture(t, ['--push', '--ts-sync', '--require-push-capability'])
  const result = await valid.service.inspect({ operation: 'diagnostics', path: 'app.ts' })
  assert.equal(result.diagnosticMode, 'typescript_sync')
  assert.equal(result.items[0].message, 'full semantic diagnostic')
  assert.deepEqual(result.items[0].range, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } })
  const failed = await fixture(t, ['--push', '--ts-sync', '--ts-sync-fail'])
  await assert.rejects(failed.service.inspect({ operation: 'diagnostics', path: 'app.ts' }), { code: 'LSP_PROTOCOL' })
})

test('unavailable servers do not trigger installation, missing isolation never falls back to host', async t => {
  const { cwd, service } = await fixture(t)
  await writeFile(path.join(cwd, 'module.go'), 'package sample\n')
  await assert.rejects(service.inspect({ operation: 'diagnostics', path: 'module.go' }), { code: 'LSP_UNAVAILABLE' })
  await assert.rejects(createLanguageService({ cwd, servers: {}, authorizeStart: async () => true }), { code: 'LSP_ISOLATION_REQUIRED' })
  await assert.rejects(createLanguageService({ cwd, mode: 'host', servers: { typescript: { command: '/usr/bin/npx', args: ['typescript-language-server'] } }, authorizeStart: async () => true }), { code: 'LSP_CONFIG' })
  await assert.rejects(createLanguageService({ cwd, mode: 'host', servers: { typescript: { command: 'relative-server', args: [] } }, authorizeStart: async () => true }), { code: 'LSP_CONFIG' })
})

test('host approval receives immutable scope/config fingerprint and can deny startup', hostRead, async t => {
  let saw = false
  const { service } = await fixture(t, [], { authorizeStart: async grant => { saw = true; assert.equal(grant.mode, 'host'); assert.equal(grant.fingerprint.length, 64); return false } })
  await assert.rejects(service.inspect({ operation: 'symbols', path: 'app.ts' }), { code: 'LSP_APPROVAL_REQUIRED' })
  assert.equal(saw, true)
})

test('closing during an asynchronous host approval cannot start a new server afterwards', hostRead, async t => {
  let ready, approve
  const reached = new Promise(resolve => { ready = resolve })
  const approval = new Promise(resolve => { approve = resolve })
  const { service } = await fixture(t, [], { authorizeStart: async () => { ready(); return approval } })
  const pending = service.inspect({ operation: 'symbols', path: 'app.ts' })
  await reached
  service.close(); approve(true)
  await assert.rejects(pending, { code: 'LSP_CLOSED' })
  assert.equal(service.status().running, 0)
})

test('host subprocess receives a minimal environment and no parent secret/loaders', hostRead, async t => {
  const saved = process.env.KK_LSP_SECRET
  process.env.KK_LSP_SECRET = 'synthetic-secret'
  try {
    const { service } = await fixture(t, ['--env'])
    assert.equal((await service.inspect({ operation: 'symbols', path: 'app.ts' })).items[0].name, 'secret=false')
  } finally { if (saved === undefined) delete process.env.KK_LSP_SECRET; else process.env.KK_LSP_SECRET = saved }
})

test('scope, symlink escape, invalid positions and write operations fail closed', hostRead, async t => {
  const { cwd, service } = await fixture(t)
  await assert.rejects(service.inspect({ operation: 'symbols', path: '../outside.ts' }), { code: 'workspace_path_violation' })
  await assert.rejects(service.inspect({ operation: 'rename', path: 'app.ts' }), { code: 'LSP_INVALID' })
  await assert.rejects(service.inspect({ operation: 'definition', path: 'app.ts', line: 900, character: 0 }), { code: 'LSP_POSITION' })
  if (process.platform !== 'win32') {
    await symlink('/etc/passwd', path.join(cwd, 'escape.ts'))
    await assert.rejects(service.inspect({ operation: 'symbols', path: 'escape.ts' }), { code: 'workspace_path_violation' })
  }
})

test('cancellation and close terminate pending queries without claiming no diagnostics', hostRead, async t => {
  const { service } = await fixture(t, ['--slow'])
  const controller = new AbortController()
  const pending = service.inspect({ operation: 'diagnostics', path: 'app.ts', signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending)
  const next = service.inspect({ operation: 'diagnostics', path: 'app.ts' })
  setTimeout(() => service.close(), 100)
  await assert.rejects(next)
  await assert.rejects(service.inspect({ operation: 'symbols', path: 'app.ts' }), { code: 'LSP_CLOSED' })
})

test('malformed and oversized protocol frames fail explicitly and leave no running service', hostRead, async t => {
  const { service } = await fixture(t, ['--malformed'])
  await assert.rejects(service.inspect({ operation: 'symbols', path: 'app.ts' }), { code: 'LSP_LIMIT' })
  assert.equal(service.status().running, 0)
})

test('all configured language routes work without implicit package resolution', hostRead, async t => {
  const servers = Object.fromEntries(LSP_LANGUAGES.map(language => [language, { command: process.execPath, args: [server] }]))
  const { service, cwd } = await fixture(t, [], { servers })
  for (const [file, language] of [['a.js', 'javascript'], ['a.tsx', 'typescript'], ['a.py', 'python'], ['a.go', 'go'], ['a.kt', 'kotlin']]) {
    await writeFile(path.join(cwd, file), 'source\n')
    assert.equal((await service.inspect({ operation: 'symbols', path: file })).language, language)
  }
})

test('LSP parent-directory swaps never inject outside canaries into didOpen', hostRead, async t => {
  const { cwd, service } = await fixture(t, ['--echo-source'])
  const outside = await mkdtemp(path.join(os.tmpdir(), 'kk-lsp-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const live = path.join(cwd, 'input'), saved = path.join(cwd, 'retired')
  await mkdir(live); await writeFile(path.join(live, 'app.ts'), 'INSIDE SOURCE')
  await writeFile(path.join(outside, 'app.ts'), 'OUTSIDE SECRET MUST NOT REACH LSP')
  assert.equal((await service.inspect({ operation: 'symbols', path: 'input/app.ts' })).items[0].name, 'INSIDE SOURCE')
  let stop = false, swaps = 0
  const attacker = (async () => {
    while (!stop) {
      await rename(live, saved); await symlink(outside, live)
      await new Promise(resolve => setImmediate(resolve))
      await unlink(live); await rename(saved, live); swaps++
    }
  })()
  try {
    for (let i = 0; i < 30; i++) {
      try { assert.equal((await service.inspect({ operation: 'symbols', path: 'input/app.ts' })).items[0].name, 'INSIDE SOURCE') }
      catch (error) { if (!['pinned_scope', 'workspace_path_violation', 'ENOENT', 'LSP_SOURCE_CHANGED'].includes(error.code)) throw error }
    }
  } finally { stop = true; await attacker }
  assert.ok(swaps > 0)
})

test('host LSP fails closed without pinned directory primitives', { skip: process.platform === 'linux' }, async t => {
  const { service } = await fixture(t)
  await assert.rejects(service.inspect({ operation: 'symbols', path: 'app.ts' }), { code: 'pinned_scope' })
})

test('strict service executes the same worker in a real read-only no-network container', {
  skip: !process.env.KK_LSP_TEST_IMAGE, timeout: 60000
}, async t => {
  const fake = await readFile(server, 'utf8')
  const { service } = await fixture(t, [], { mode: 'strict', image: process.env.KK_LSP_TEST_IMAGE,
    servers: { typescript: { command: '/usr/local/bin/node', args: ['--input-type=module', '-e', fake] } } })
  const result = await service.inspect({ operation: 'symbols', path: 'app.ts' })
  assert.equal(result.items[0].name, 'readOnlySymbol')
  assert.deepEqual(result.isolation, { backend: 'docker', strict: true, network: 'none' })
})
