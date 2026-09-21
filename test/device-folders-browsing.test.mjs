import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeviceService } from '../src/device/service.mjs'
import { listDeviceFolder, resolveDevicePath } from '../src/device/files.mjs'

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kkcode-folders-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}

test('default device roots cover the OS user home, and --root remains an explicit restriction', async () => {
  const service = new DeviceService()
  assert.deepEqual(service.roots, [os.homedir()])
  const restricted = new DeviceService({ roots: [path.resolve('/some/where')] })
  assert.deepEqual(restricted.roots, [path.resolve('/some/where')])
})

test('home-wide browsing: any folder under the home root is reachable, siblings of the terminal cwd included', async t => {
  const base = await fixture(t)
  const home = path.join(base, 'home'), terminalCwd = path.join(home, 'work', 'project'), elsewhere = path.join(home, 'elsewhere', 'nested')
  await mkdir(terminalCwd, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  await writeFile(path.join(elsewhere, 'notes.txt'), 'reachable')
  // The terminal was started deep in the tree; browsing still covers all of home.
  const roots = [home]
  assert.equal(await resolveDevicePath(elsewhere, roots, { directory: true }), elsewhere)
  const listed = await listDeviceFolder(elsewhere, roots)
  assert.deepEqual(listed.entries.map(entry => entry.name), ['notes.txt'])
  assert.equal((await listDeviceFolder(undefined, roots)).path, home, 'no path opens the home entry')
  // Above home stays out of scope, and credential folders stay protected.
  await assert.rejects(resolveDevicePath(path.dirname(home), roots, { directory: true }), { code: 'path_denied' })
  await mkdir(path.join(home, '.ssh'))
  await writeFile(path.join(home, '.ssh', 'id_rsa'), 'fixture')
  await assert.rejects(resolveDevicePath(path.join(home, '.ssh'), roots, { directory: true }), { code: 'path_denied' })
  const homeListing = await listDeviceFolder(home, roots)
  assert.ok(!homeListing.entries.some(entry => entry.name === '.ssh'), 'credential folders are not enumerated')
})

test('parent field walks up to the root boundary and stops there', async t => {
  const base = await fixture(t)
  const root = path.join(base, 'root'), deep = path.join(root, 'a', 'b')
  await mkdir(deep, { recursive: true })
  const roots = [root]
  const level2 = await listDeviceFolder(deep, roots)
  assert.equal(level2.parent, path.join(root, 'a'))
  const level1 = await listDeviceFolder(level2.parent, roots)
  assert.equal(level1.parent, root)
  const atRoot = await listDeviceFolder(level1.parent, roots)
  assert.equal(atRoot.parent, null, 'the allowed root itself has no parent')
  // A parent outside the configured roots is never exposed.
  const outside = path.join(base, 'outside')
  await mkdir(outside)
  await assert.rejects(listDeviceFolder(outside, roots), { code: 'path_denied' })
})

test('missing and unreadable folders fail with stable tolerance codes, not raw 500s', async t => {
  const base = await fixture(t)
  const roots = [base]
  await assert.rejects(listDeviceFolder(path.join(base, 'missing'), roots), { code: 'path_missing', status: 404 })
  await assert.rejects(resolveDevicePath(path.join(base, 'missing'), roots), { code: 'path_missing', status: 404 })
  const file = path.join(base, 'file.txt')
  await writeFile(file, 'x')
  await assert.rejects(listDeviceFolder(file, roots), { code: 'not_directory' })
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = path.join(base, 'locked')
    await mkdir(locked, { mode: 0o000 })
    t.after(() => chmod(locked, 0o700).catch(() => {}))
    await assert.rejects(listDeviceFolder(locked, roots), { code: 'folder_unreadable', status: 403 })
  }
  // A missing configured root degrades instead of poisoning the other roots.
  const usable = path.join(base, 'usable')
  await mkdir(usable)
  const mixed = await listDeviceFolder(undefined, [path.join(base, 'gone'), usable])
  assert.equal(mixed.path, usable)
})
