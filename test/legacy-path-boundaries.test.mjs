import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readDeviceFile } from '../src/device/files.mjs'
import { expandFileMentions } from '../src/repl/file-mention.mjs'

const execute = promisify(execFile)

test('remote preview cannot expose protected or out-of-root content through an ordinary hard-link name', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-legacy-path-'))
  const previous = process.env.KKCODE_HOME
  const state = path.join(root, 'private-state'), workspace = path.join(root, 'workspace'), ssh = path.join(root, '.ssh')
  process.env.KKCODE_HOME = state
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([state, workspace, ssh].map(directory => mkdir(directory)))
  const protectedFiles = [path.join(state, 'remote-credentials.json'), path.join(ssh, 'id_rsa'), path.join(root, 'outside.txt')]
  for (const [index, original] of protectedFiles.entries()) {
    const canary = `PROTECTED_FIXTURE_${index}`
    await writeFile(original, canary)
    const alias = path.join(workspace, `ordinary-${index}.txt`)
    await link(original, alias)
    await assert.rejects(readDeviceFile(alias, [workspace]), { code: 'path_denied', status: 403 })
    assert.equal(await readFile(original, 'utf8'), canary)
  }
  const ordinary = path.join(workspace, 'ordinary.txt')
  await writeFile(ordinary, 'ordinary preview works')
  assert.deepEqual(await readDeviceFile(ordinary, [workspace]), { path: await realpath(ordinary), content: 'ordinary preview works' })
})

test('file mentions do not open FIFOs, sockets or character devices as text', async () => {
  let reads = 0
  const fs = {
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => false, isFile: () => false, size: 0 }),
    readFileSync() { reads++; return Buffer.from('must not reach a special file') }
  }
  const result = await expandFileMentions('inspect @special-file', { fs })
  assert.equal(reads, 0)
  assert.deepEqual(result.attached, [])
  assert.equal(result.text, 'inspect @special-file')
  assert.equal(result.skipped[0].reason, 'unreadable')
})

test('a real named pipe mention returns without blocking the CLI reader', {
  skip: process.platform === 'win32' ? 'POSIX named pipes are not available on Windows; special-file guard is tested on every platform' : false,
  timeout: 10000
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-mention-pipe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fifo = path.join(root, 'no-writer')
  await execute('mkfifo', [fifo])
  const moduleUrl = new URL('../src/repl/file-mention.mjs', import.meta.url).href
  const child = await execute(process.execPath, ['--input-type=module', '-e', `
    const { default: fs } = await import('node:fs');
    const { expandFileMentions } = await import(process.argv[1]);
    const result = await expandFileMentions('@no-writer', { cwd: process.argv[2] });
    // Simulate a regular-file stat made before another process swapped in the
    // pipe. The real open/fstat must still reject it without waiting for writers.
    const staleStatFs = { ...fs, statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 1 }) };
    const changed = await expandFileMentions('@no-writer', { cwd: process.argv[2], fs: staleStatFs });
    process.stdout.write(JSON.stringify([result, changed]));
  `, moduleUrl, root], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096 })
  for (const result of JSON.parse(child.stdout)) {
    assert.deepEqual(result.attached, [])
    assert.equal(result.skipped[0].reason, 'unreadable')
  }
})

test('real descriptor mention reads remain bounded if the file grew after both size checks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-mention-growth-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'growing.txt'), 'a'.repeat(128))
  let bytesRead = 0
  const growingFs = { ...fs,
    statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 1 }),
    fstatSync: () => ({ isFile: () => true, size: 1 }),
    readSync(...args) { const count = fs.readSync(...args); bytesRead += count; return count }
  }
  const result = await expandFileMentions('@growing.txt', { cwd: root, fs: growingFs, maxReadBytes: 8 })
  assert.deepEqual(result.attached, [])
  assert.equal(result.skipped[0].reason, 'too-large')
  assert.equal(bytesRead, 9, 'read only the cap plus one byte, not the whole grown file')
})
