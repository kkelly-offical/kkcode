import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import { chooseRemoteFolderAccess, allDeviceFolderRoots, parseWindowsFolderRoots } from '../src/remote/folder-access.mjs'
import { listDeviceFolder } from '../src/device/files.mjs'

test('interactive remote asks for all-folder consent; project trust alone never grants it', async () => {
  const prompts = [], messages = [], home = '/fixture/home'
  for(const answer of ['y', 'yes', '是', '允许']) {
    const result = await chooseRemoteFolderAccess({ trust: true }, { home, interactive: true, ask: async prompt => { prompts.push(prompt); return answer }, print: text => messages.push(text), rootsForAll: async () => [home, '/'] })
    assert.deepEqual(result, { mode: 'all', roots: [home, '/'] })
  }
  assert.equal(prompts.length, 4)
  assert.ok(messages.some(text => text.includes('私密状态仍受保护')))
  for(const answer of ['', 'n', 'NO', '否']) assert.deepEqual(await chooseRemoteFolderAccess({}, { home, interactive: true, ask: async () => answer, print() {} }), { mode: 'home', roots: [home] })
  await assert.rejects(chooseRemoteFolderAccess({}, { home, interactive: true, ask: async () => 'maybe', print() {} }), /没有得到明确授权/)
})

test('non-interactive remote fails closed unless folder scope is explicit', async () => {
  await assert.rejects(chooseRemoteFolderAccess({ trust: true }, { interactive: false }), /--home-only/)
  const home = '/fixture/home'
  assert.deepEqual(await chooseRemoteFolderAccess({ homeOnly: true }, { home, interactive: false }), { mode: 'home', roots: [home] })
  assert.deepEqual(await chooseRemoteFolderAccess({ root: 'child' }, { cwd: process.cwd(), interactive: false }), { mode: 'custom', roots: [path.resolve('child')] })
  assert.deepEqual(await chooseRemoteFolderAccess({ allFolders: true }, { interactive: false, rootsForAll: async () => ['fixture-all'] }), { mode: 'all', roots: ['fixture-all'] })
  for(const options of [{ root: '.', allFolders: true }, { homeOnly: true, allFolders: true }, { root: '.', homeOnly: true }]) await assert.rejects(chooseRemoteFolderAccess(options), /不能同时/)
})

test('all-folder roots start at home and enumerate Windows local volumes without UNC probing', async () => {
  assert.deepEqual(await allDeviceFolderRoots({ platform: 'linux', home: '/home/user' }), ['/home/user', '/'])
  assert.deepEqual(await allDeviceFolderRoots({ platform: 'darwin', home: '/Users/user' }), ['/Users/user', '/'])
  const calls = []
  assert.deepEqual(await allDeviceFolderRoots({ platform: 'win32', home: 'C:\\Users\\user', executeImpl: async (...args) => { calls.push(args); return { stdout: '["C:","D:"]' } } }), ['C:\\Users\\user', 'C:\\', 'D:\\'])
  assert.match(calls[0][1].at(-1), /DriveType -ne 4/)
  assert.deepEqual(parseWindowsFolderRoots('"C:"'), ['C:\\'])
  for(const invalid of ['[]', '["C:\\\\evil"]', '["//server/share"]', '[1]', 'null']) assert.throws(() => parseWindowsFolderRoots(invalid))
})

test('broader authorized roots admit ordinary sibling folders but keep credential paths protected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-folder-consent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), sibling = path.join(root, 'projects')
  await mkdir(home); await mkdir(sibling); await mkdir(path.join(home, '.ssh'))
  await assert.rejects(listDeviceFolder(sibling, [home]), error => error.code === 'path_denied' && error.message.includes('授权') && !error.message.includes('Path is outside'))
  assert.equal((await listDeviceFolder(sibling, [home, root])).path, await (await import('node:fs/promises')).realpath(sibling))
  await assert.rejects(listDeviceFolder(path.join(home, '.ssh'), [home, root]), { code: 'path_denied' })
})

test('all-folder access does not expose Linux process environments or device/runtime pseudo-files', { skip: process.platform !== 'linux' }, async () => {
  for(const target of ['/proc/self', '/sys', '/dev', '/run']) await assert.rejects(listDeviceFolder(target, ['/']), { code: 'path_denied' })
})
