import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile, access } from 'node:fs/promises'
import { create as tar } from 'tar'
import { inspectNpmEnvironment, prepareNpmEnvironment, restoreNpmEnvironment, verifyNpmEnvironment } from '../src/sdk/environments.mjs'

const image = process.env.KKCODE_STRICT_TEST_IMAGE
const real = { skip: !image, timeout: 90000 }
async function fixture(t, { files = {}, script = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-npm-independent-')), cwd = path.join(root, 'project'), storageRoot = path.join(root, 'private-store')
  const packageRoot = path.join(root, 'archive', 'package')
  await mkdir(cwd); await mkdir(storageRoot, { mode: 0o700 }); await mkdir(packageRoot, { recursive: true })
  const manifest = { name: 'independent-fixture', version: '1.0.0', main: 'index.cjs', ...(script ? { scripts: { postinstall: script } } : {}) }
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(packageRoot, 'index.cjs'), 'module.exports = 42\n')
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(packageRoot, name), content)
  const packed = path.join(root, 'fixture.tgz')
  await tar({ cwd: path.dirname(packageRoot), file: packed, gzip: true }, ['package'])
  const body = await readFile(packed)
  let requests = 0
  const server = http.createServer((_req, response) => { requests++; response.end(body) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const project = { name: 'review-project', version: '1.0.0', dependencies: { 'independent-fixture': '1.0.0' } }
  const lock = { name: project.name, version: project.version, lockfileVersion: 3, requires: true,
    packages: { '': project, 'node_modules/independent-fixture': { version: '1.0.0', resolved: `${origin}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`, ...(script ? { hasInstallScript: true } : {}) } } }
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(project)); await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  return { root, cwd, storageRoot, requests: () => requests,
    inspect: limits => inspectNpmEnvironment({ cwd, image, registryOrigins: [origin], allowPrivate: true, ...(limits ? { limits } : {}) }) }
}

test('independent archive review rejects sensitive content rather than signing its masked empty view', real, async t => {
  const f = await fixture(t, { files: { '.env': 'not-a-real-secret-but-must-not-become-unsealed' } })
  const plan = await f.inspect()
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_ARCHIVE' })
  assert.equal(f.requests(), 1)
  assert.equal((await readdir(f.storageRoot)).some(name => name.startsWith('npm-')), false)
  await assert.rejects(access(path.join(f.cwd, 'node_modules')), { code: 'ENOENT' })
})

test('an approved offline hook cannot hide oversized .env bytes from the environment seal', real, async t => {
  const f = await fixture(t, { script: "node -e \"require('node:fs').writeFileSync('.env','x'.repeat(8192))\"" })
  const plan = await f.inspect({ unpackBytes: 4096 })
  let approvals = 0
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true,
    authorizeScripts: () => { approvals++; return true } }), { code: 'DEPENDENCY_HELPER' })
  assert.equal(approvals, 1)
  assert.equal((await readdir(f.storageRoot)).some(name => name.startsWith('npm-')), false)
  await assert.rejects(access(path.join(f.cwd, '.env')), { code: 'ENOENT' })
})

test('package-root binding.gyp cannot be mislabeled ready just because package.json omits gypfile', real, async t => {
  const f = await fixture(t, { files: { 'binding.gyp': '{"targets":[]}' } }), plan = await f.inspect()
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_UNSUPPORTED' })
})

test('private signing state cannot overlap the source or a later task mount', real, async t => {
  const f = await fixture(t), plan = await f.inspect(), overlapping = path.join(f.cwd, 'cache')
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: overlapping, authorize: () => true }), { code: 'DEPENDENCY_STORAGE' })
  await assert.rejects(access(path.join(overlapping, 'signing.key')), { code: 'ENOENT' })
  const environment = await prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true })
  for (const name of ['package.json', 'package-lock.json']) await copyFile(path.join(f.cwd, name), path.join(f.root, name))
  await assert.rejects(verifyNpmEnvironment({ environment, cwd: f.root, image }), { code: 'DEPENDENCY_STORAGE' })
})

test('editing a stored proof cannot upgrade unapproved install hooks into a restored ready environment', real, async t => {
  const f = await fixture(t, { script: "node -e \"require('node:fs').writeFileSync('built','yes')\"" }), plan = await f.inspect()
  const environment = await prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true })
  assert.equal(environment.status, 'needs_offline_build')
  await assert.rejects(access(path.join(environment.directory, 'job/node_modules/independent-fixture/built')), { code: 'ENOENT' })
  const file = path.join(environment.directory, 'environment.json'), original = JSON.parse(await readFile(file, 'utf8'))
  original.proof.status = 'ready'
  await writeFile(file, JSON.stringify(original))
  await assert.rejects(restoreNpmEnvironment({ directory: environment.directory, storageRoot: f.storageRoot }), { code: 'DEPENDENCY_PROOF' })
})
