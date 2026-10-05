import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const exec = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kk-web-display-')), bundle = path.join(root, 'patch'), target = path.join(root, 'gateway')
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = { 'index.html': '<script src="assets/base.js"></script>', 'assets/base.js': 'base bundle' }
  const patch = { 'index.html': '<script src="assets/display.js"></script>', 'assets/display.js': 'display bundle', 'display-patch.json': '{"displayVersion":"1.0.11-display.1"}' }
  const entries = value => Object.entries(value).map(([file, content]) => ({ path: file, size: Buffer.byteLength(content), sha256: sha(content) }))
  const write = async (directory, name, text) => { const file = path.join(directory, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }
  for (const [name, content] of Object.entries(base)) await write(path.join(target, 'src/web'), name, content)
  for (const [name, content] of Object.entries(patch)) await write(path.join(bundle, 'src/web'), name, content)
  await write(target, 'package.json', JSON.stringify({ name: '@kkelly-offical/kkcode', version: '1.0.11' }))
  await write(target, 'config.yaml', 'preserve all deployment configuration')
  await write(bundle, 'manifest.json', JSON.stringify({ schema: 1, kind: 'kkcode-web-display', baseVersion: '1.0.11', displayVersion: '1.0.11-display.1', files: entries(patch), baseFiles: entries(base), source: { commit: 'fixture' } }))
  await copyFile(new URL('../deploy/apply-web-display-patch.mjs', import.meta.url), path.join(bundle, 'apply.mjs'))
  const run = (...args) => exec(process.execPath, [path.join(bundle, 'apply.mjs'), '--target', target, ...args])
  const web = name => path.join(target, 'src/web', name)
  return { root, bundle, target, base, patch, run, web }
}
test('display overlay verifies, preserves old browser assets/config, applies idempotently, and rolls back', async t => {
  const f = await fixture(t), result = await f.run()
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line)), backup = lines.at(-1).backup
  assert.equal(lines.at(-1).installed, '1.0.11-display.1')
  assert.equal(await readFile(f.web('index.html'), 'utf8'), f.patch['index.html'])
  assert.equal(await readFile(f.web('assets/base.js'), 'utf8'), f.base['assets/base.js'])
  assert.equal(await readFile(path.join(f.target, 'config.yaml'), 'utf8'), 'preserve all deployment configuration')
  assert.equal(JSON.parse((await f.run()).stdout).alreadyInstalled, '1.0.11-display.1')
  await f.run('--rollback', backup)
  assert.equal(await readFile(f.web('index.html'), 'utf8'), f.base['index.html'])
  assert.equal(await readFile(f.web('assets/display.js'), 'utf8'), f.patch['assets/display.js'])
  await assert.rejects(readFile(f.web('display-patch.json')), { code: 'ENOENT' })
  assert.equal(JSON.parse((await f.run()).stdout.trim().split('\n').at(-1)).installed, '1.0.11-display.1')
})
test('wrong gateway version and tampered payload never alter the installed Web', async t => {
  const f = await fixture(t), manifest = path.join(f.target, 'package.json')
  await writeFile(manifest, JSON.stringify({ name: '@kkelly-offical/kkcode', version: '1.0.10' }))
  await assert.rejects(f.run(), /requires KK Code 1\.0\.11/)
  await writeFile(manifest, JSON.stringify({ name: '@kkelly-offical/kkcode', version: '1.0.11' }))
  await writeFile(path.join(f.bundle, 'src/web/assets/display.js'), 'tampered')
  await assert.rejects(f.run(), /Checksum mismatch/)
  assert.equal(await readFile(f.web('index.html'), 'utf8'), f.base['index.html'])
  assert.deepEqual((await readdir(path.join(f.target, 'src'))).sort(), ['web'])
})
test('local Web edits, foreign backups and existing installer locks remain untouched', async t => {
  const f = await fixture(t)
  await writeFile(f.web('custom.css'), 'local customization')
  await assert.rejects(f.run(), /local change/)
  assert.equal(await readFile(f.web('custom.css'), 'utf8'), 'local customization')
  await rm(f.web('custom.css'))
  const lock = path.join(f.target, 'src/.kkcode-web-display.lock')
  await writeFile(lock, 'another installer owns this lock')
  await assert.rejects(f.run(), /Another display installer/)
  assert.equal(await readFile(lock, 'utf8'), 'another installer owns this lock')
  await rm(lock)
  const foreign = path.join(f.root, 'foreign-backup'); await mkdir(foreign)
  await assert.rejects(f.run('--rollback', foreign), /Backup must belong/)
  assert.equal(await readFile(f.web('index.html'), 'utf8'), f.base['index.html'])
})
