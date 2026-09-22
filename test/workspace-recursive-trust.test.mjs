import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkWorkspaceTrust, persistTrust, revokeTrust } from '../src/kernel/permission/workspace-trust.mjs'
import { assertProviderOutboundAllowed } from '../src/kernel/provider/security.mjs'
import { grantRemoteWorkspaceTrust } from '../src/remote/workspace-access.mjs'
import { trustFilePath } from '../src/storage/paths.mjs'
import { DeviceService } from '../src/device/service.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kkcode-recursive-trust-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(directory, 'private-state')
  t.after(async () => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  const root = path.join(directory, 'projects'), child = path.join(root, 'child'), sibling = path.join(directory, 'projects-other')
  await mkdir(child, { recursive: true }); await mkdir(sibling)
  return { directory, root, child, sibling }
}
const trusted = async cwd => (await checkWorkspaceTrust({ cwd, isTTY: false })).trusted
const outbound = cwd => assertProviderOutboundAllowed({
  config: { provider: { custom: { type: 'openai', base_url: 'https://fixture.invalid/v1' } } },
  source: { cwd, projectRaw: { provider: { custom: { base_url: 'https://fixture.invalid/v1', api_key: 'fixture-key' } } } }
}, { providerName: 'custom', protocol: 'openai', operation: 'provider inference' })

test('ordinary exact trust remains exact; recursive trust covers future folders and provider checks', async t => {
  const { root, child, sibling } = await fixture(t)
  await persistTrust(root)
  assert.equal(await trusted(root), true); assert.equal(await trusted(child), false)
  await assert.rejects(outbound(child), error => error.details.reason === 'workspace_untrusted')
  await persistTrust(root, { recursive: true })
  await checkWorkspaceTrust({ cwd: await realpath(root), cliTrust: true, isTTY: false })
  const future = path.join(child, 'created-after-grant'); await mkdir(future)
  assert.equal(await trusted(child), true); assert.equal(await trusted(future), true); assert.equal(await trusted(sibling), false)
  await assert.doesNotReject(outbound(future))
  const record = JSON.parse(await readFile(trustFilePath(await realpath(root)), 'utf8'))
  assert.equal(record.recursive, true)
  if (process.platform !== 'win32') assert.equal((await stat(trustFilePath(await realpath(root)))).mode & 0o077, 0)
})

test('explicit untrust wins over inherited grants, can be explicitly approved again, and tree revocation persists', async t => {
  const { root, child } = await fixture(t)
  await persistTrust(root, { recursive: true }); await revokeTrust(child)
  assert.equal(await trusted(child), false)
  await assert.rejects(outbound(child), error => error.details.reason === 'workspace_untrusted')
  assert.equal((await checkWorkspaceTrust({ cwd: child, isTTY: true, prompt: async () => 'yes' })).trusted, true)
  await revokeTrust(root)
  const another = path.join(root, 'another'); await mkdir(another)
  assert.equal(await trusted(another), false)
  assert.equal(await trusted(child), true, 'separate explicit grants are not silently removed')
  assert.equal(JSON.parse(await readFile(trustFilePath(await realpath(root)), 'utf8')).recursive, true)
  await persistTrust(await realpath(root))
  assert.equal(await trusted(root), true)
  assert.equal(await trusted(another), false, 'exact re-approval must not restore a revoked tree grant')
})

test('recursive inheritance follows physical directories and rejects symlink escapes', async t => {
  const { root, child, sibling, directory } = await fixture(t)
  await persistTrust(root, { recursive: true })
  const escape = path.join(root, 'escape'), alias = path.join(directory, 'alias')
  await symlink(sibling, escape, process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(child, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await trusted(escape), false); assert.equal(await trusted(alias), true)
  await revokeTrust(alias)
  assert.equal(await trusted(alias), false); assert.equal(await trusted(child), false)
})

test('canonical re-approval overrides a stale alias tombstone without restoring recursive access', async t => {
  const { root, child, directory } = await fixture(t)
  const alias = path.join(directory, 'alias-projects')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await persistTrust(root, { recursive: true })
  await revokeTrust(alias)
  assert.equal(await trusted(alias), false); assert.equal(await trusted(root), false)
  await persistTrust(await realpath(root))
  assert.equal(await trusted(alias), true); assert.equal(await trusted(root), true)
  assert.equal(await trusted(child), false, 're-approval stays exact; the revoked tree must not return')
  await revokeTrust(alias)
  assert.equal(await trusted(root), false, 'canonical identity still receives explicit untrust from an alias')
})

test('project-local self-trust and malformed private grants cannot bypass the trust boundary', async t => {
  const { root, child } = await fixture(t)
  await mkdir(path.join(child, '.kkcode'))
  await writeFile(path.join(child, '.kkcode', 'trust.json'), JSON.stringify({ trusted: true, recursive: true }))
  assert.equal(await trusted(child), false)
  await persistTrust(root, { recursive: true })
  await writeFile(trustFilePath(child), '{not valid JSON')
  assert.equal(await trusted(child), false)
  await persistTrust(child)
  assert.equal(await trusted(child), true)
  await assert.rejects(persistTrust(path.join(root, 'missing'), { recursive: true }), { code: 'ENOENT' })
})

test('remote browsing does not grant workspace trust; explicit opt-in validates all roots and minimizes grants', async t => {
  const { root, child, sibling } = await fixture(t)
  const writes = [], grant = async (...args) => { writes.push(args) }
  assert.deepEqual(await grantRemoteWorkspaceTrust([root], { grant }), [])
  assert.deepEqual(await grantRemoteWorkspaceTrust([root], { enabled: false, grant }), [])
  assert.deepEqual(writes, [])
  const roots = await grantRemoteWorkspaceTrust([root, child, sibling], { enabled: true, grant })
  assert.deepEqual(new Set(roots), new Set(await Promise.all([root, sibling].map(folder => realpath(folder)))))
  assert.equal(writes.length, 2); assert.ok(writes.every(([, options]) => options.recursive === true))
  writes.length = 0
  await assert.rejects(grantRemoteWorkspaceTrust([root, process.env.KKCODE_HOME], { enabled: true, grant }))
  assert.deepEqual(writes, [], 'an invalid/private root cannot leave partial grants during validation')
})

test('real DeviceService kernels inherit approved trust across folders without disabling private-path protection', async t => {
  const { root, child } = await fixture(t)
  await grantRemoteWorkspaceTrust([root], { enabled: true })
  const service = await new DeviceService({ cwd: root, roots: [root] }).initialize()
  try {
    const kernel = await service.kernel(child)
    assert.equal(kernel.trustState.trusted, true)
    assert.equal(kernel.permissions.isTrusted(), true)
    const future = path.join(root, 'future'); await mkdir(future)
    assert.equal((await service.kernel(future)).trustState.trusted, true)
    const privateFolder = path.join(child, '.ssh'); await mkdir(privateFolder)
    await assert.rejects(service.kernel(privateFolder), { code: 'path_denied' })
  } finally { await service.close() }
})
