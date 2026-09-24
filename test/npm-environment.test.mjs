import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, access, symlink } from 'node:fs/promises'
import { create as createTar } from 'tar'
import { inspectNpmEnvironment, prepareNpmEnvironment, restoreNpmEnvironment, verifyNpmEnvironment, prepareNpmWorkspace } from '../src/sdk/environments.mjs'
import { runStrictCommand, createDockerExecutionBackend } from '../src/kernel/isolation/docker-executor.mjs'
import { createLanguageService } from '../src/kernel/lsp/service.mjs'
import { createIsolatedLanguageServerConfigs } from '../src/kernel/lsp/image-preset.mjs'

const image = process.env.KKCODE_STRICT_TEST_IMAGE
const opts = { skip: !image, timeout: 240000 }
async function fixture(t, { hook = false, lockfileVersion = 3, hookSource = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-deps-test-')), cwd = path.join(root, 'source'), packageDir = path.join(root, 'archive', 'package'), storageRoot = path.join(root, 'store')
  await mkdir(cwd); await mkdir(packageDir, { recursive: true }); await mkdir(storageRoot, { mode: 0o700 })
  const manifest = { name: 'fixture-dep', version: '1.0.0', main: 'index.cjs', ...(hook ? { scripts: { postinstall: 'node install.cjs' } } : {}) }
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(packageDir, 'index.cjs'), 'module.exports = 42\n')
  if (hook) await writeFile(path.join(packageDir, 'install.cjs'), hookSource || "const fs=require('node:fs'),http=require('node:http');if(process.env.KKCODE_TEST_DEP_SECRET)process.exit(2);if(fs.existsSync('/workspace/source-marker'))process.exit(3);fs.writeFileSync('built','yes');http.get('http://127.0.0.1:9',()=>process.exit(4)).on('error',()=>process.exit(0));")
  const tarball = path.join(root, 'package.tgz')
  await createTar({ cwd: path.dirname(packageDir), file: tarball, gzip: true }, ['package'])
  let bytes = await readFile(tarball), requests = 0
  const server = http.createServer((req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const project = { name: 'dependency-test', version: '1.0.0', scripts: { install: 'node -e "process.exit(95)"', test: 'node verify.cjs', build: 'node verify.cjs' }, dependencies: { 'fixture-dep': '1.0.0' } }
  const lock = { name: project.name, version: project.version, lockfileVersion, requires: true, packages: {
    '': { name: project.name, version: project.version, dependencies: project.dependencies },
    'node_modules/fixture-dep': { version: '1.0.0', resolved: `${origin}/package.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, ...(hook ? { hasInstallScript: true } : {}) }
  } }
  if (lockfileVersion === 2) lock.dependencies = { 'fixture-dep': { version: '1.0.0', resolved: `${origin}/package.tgz`, integrity: lock.packages['node_modules/fixture-dep'].integrity } }
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(project))
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock))
  await writeFile(path.join(cwd, 'source-marker'), 'private-original')
  await writeFile(path.join(cwd, 'verify.cjs'), "require('node:assert/strict').equal(require('fixture-dep'),42);console.log('deps-work')")
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  return { root, cwd, origin, storageRoot, lock, project, packageDir, tarball, requests: () => requests, corrupt: () => { bytes = Buffer.from('corrupt') },
    replaceTar: async () => { await createTar({ cwd: path.dirname(packageDir), file: tarball, gzip: true }, ['package']); bytes = await readFile(tarball); lock.packages['node_modules/fixture-dep'].integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`; await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock)) },
    inspect: () => inspectNpmEnvironment({ cwd, image, registryOrigins: [origin], allowPrivate: true }) }
}

test('npm v3 preparation actually builds/tests offline with shared readonly task and verification dependencies', opts, async t => {
  const f = await fixture(t), plan = await f.inspect()
  assert.equal(f.requests(), 0)
  assert.ok(Object.isFrozen(plan.packages[0]))
  const environment = await prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: async approval => { assert.equal(approval.id, plan.id); return true } })
  assert.equal(environment.status, 'ready'); assert.equal(f.requests(), 1)
  await assert.rejects(access(path.join(f.cwd, 'node_modules')), { code: 'ENOENT' })
  const task = path.join(f.root, 'task'), verification = path.join(f.root, 'verification')
  await cp(f.cwd, task, { recursive: true }); await cp(f.cwd, verification, { recursive: true })
  await prepareNpmWorkspace({ environment, cwd: task, image })
  const backend = createDockerExecutionBackend({ image, dependencyEnvironment: environment })
  await backend.ensureReady({ cwd: task, contract: { allowedPaths: ['.'] } })
  const result = await backend.runCommand({ command: 'npm', args: ['test', '--offline'], cwd: task, shell: false })
  assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /deps-work/)
  assert.deepEqual(result.isolation.dependencyEnvironment, { id: environment.id, planId: environment.planId, treeHash: environment.treeHash, imageId: environment.imageId })
  const independent = backend.createVerificationBackend()
  await independent.ensureReady({ cwd: verification, contract: { allowedPaths: ['.'] } })
  const verified = await independent.runCommand({ command: 'npm', args: ['run', 'build', '--offline'], cwd: verification, shell: false })
  assert.equal(verified.exitCode, 0)
  assert.deepEqual(verified.isolation.dependencyEnvironment, result.isolation.dependencyEnvironment)
  const write = await runStrictCommand({ image, workspaceDir: task, dependencyEnvironment: environment,
    argv: ['node', '-e', "require('node:fs').writeFileSync('node_modules/fixture-dep/index.cjs','bad')"] })
  assert.notEqual(write.exitCode, 0); assert.match(write.stderr, /EROFS/)
  const restored = await restoreNpmEnvironment({ directory: environment.directory, storageRoot: f.storageRoot })
  assert.equal((await verifyNpmEnvironment({ environment: restored, cwd: task, image })).valid, true)
  await writeFile(path.join(task, 'package.json'), `${JSON.stringify(f.project)}\n`)
  await assert.rejects(backend.runCommand({ command: 'npm', args: ['test'], cwd: task, shell: false }), { code: 'DEPENDENCY_STALE' })
  await writeFile(path.join(environment.directory, 'job', 'node_modules', 'fixture-dep', 'index.cjs'), 'tampered')
  await assert.rejects(restoreNpmEnvironment({ directory: environment.directory, storageRoot: f.storageRoot }), { code: 'DEPENDENCY_STALE' })
})

test('npm v2 install hooks are separate immutable host approval and stay offline without source or secrets', opts, async t => {
  const f = await fixture(t, { hook: true, lockfileVersion: 2 }), plan = await f.inspect()
  const pending = await prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true })
  assert.equal(pending.status, 'needs_offline_build')
  await assert.rejects(access(path.join(pending.directory, 'job/node_modules/fixture-dep/built')), { code: 'ENOENT' })
  await assert.rejects(verifyNpmEnvironment({ environment: pending, cwd: f.cwd, image }), { code: 'DEPENDENCY_NOT_READY' })
  const prior = process.env.KKCODE_TEST_DEP_SECRET; process.env.KKCODE_TEST_DEP_SECRET = 'not-in-container'
  t.after(() => { if (prior === undefined) delete process.env.KKCODE_TEST_DEP_SECRET; else process.env.KKCODE_TEST_DEP_SECRET = prior })
  let approvals = 0
  const ready = await prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true, authorizeScripts: approval => {
    approvals++; assert.equal(approval.network, 'none'); assert.equal(approval.scripts[0].event, 'postinstall'); assert.equal(approval.scripts[0].path, 'node_modules/fixture-dep'); assert.ok(Object.isFrozen(approval.scripts[0])); return true
  } })
  assert.equal(approvals, 1); assert.equal(ready.status, 'ready')
  assert.equal(await readFile(path.join(ready.directory, 'job/node_modules/fixture-dep/built'), 'utf8'), 'yes')
  await assert.rejects(access(path.join(ready.directory, 'job/source-marker')), { code: 'ENOENT' })
})

test('dependency approval, immutable lock, origins, integrity and unsafe source paths fail closed', opts, async t => {
  const f = await fixture(t), plan = await f.inspect()
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => false }), { code: 'DEPENDENCY_DENIED' })
  assert.equal(f.requests(), 0)
  await assert.rejects(prepareNpmEnvironment({ plan: structuredClone(plan), storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_APPROVAL' })
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: async () => { await writeFile(path.join(f.cwd, 'package.json'), `${JSON.stringify(f.project)}\n`); return true } }), { code: 'DEPENDENCY_STALE' })
  await writeFile(path.join(f.cwd, 'package.json'), JSON.stringify(f.project))
  f.corrupt()
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_INTEGRITY' })
  await assert.rejects(inspectNpmEnvironment({ cwd: f.cwd, image, registryOrigins: ['https://registry.npmjs.org'] }), { code: 'DEPENDENCY_ORIGIN' })
  const original = await readFile(path.join(f.cwd, 'package-lock.json'))
  await rm(path.join(f.cwd, 'package-lock.json')); await writeFile(path.join(f.root, 'outside-lock'), original)
  await symlink(path.join(f.root, 'outside-lock'), path.join(f.cwd, 'package-lock.json'))
  await assert.rejects(f.inspect())
})

test('dependency archive links, duplicate expanded quota, proof tampering and nonempty mounts are rejected', opts, async t => {
  const f = await fixture(t)
  const plain = await readFile(path.join(f.packageDir, 'package.json')), code = await readFile(path.join(f.packageDir, 'index.cjs'))
  f.lock.packages['node_modules/fixture-dep/node_modules/fixture-dep'] = { ...f.lock.packages['node_modules/fixture-dep'] }
  await writeFile(path.join(f.cwd, 'package-lock.json'), JSON.stringify(f.lock))
  const duplicate = await inspectNpmEnvironment({ cwd: f.cwd, image, registryOrigins: [f.origin], allowPrivate: true, limits: { unpackBytes: plain.length + code.length + 10 } })
  await assert.rejects(prepareNpmEnvironment({ plan: duplicate, storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_LIMIT' })
  assert.equal(f.requests(), 1)
  delete f.lock.packages['node_modules/fixture-dep/node_modules/fixture-dep']
  await writeFile(path.join(f.cwd, 'package-lock.json'), JSON.stringify(f.lock))
  const entryLimited = await inspectNpmEnvironment({ cwd: f.cwd, image, registryOrigins: [f.origin], allowPrivate: true, limits: { unpackEntries: 2 } })
  await assert.rejects(prepareNpmEnvironment({ plan: entryLimited, storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_LIMIT' })
  await symlink('/etc/passwd', path.join(f.packageDir, 'unsafe'))
  await f.replaceTar()
  await assert.rejects(prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_ARCHIVE' })
  await rm(path.join(f.packageDir, 'unsafe')); await f.replaceTar()
  await writeFile(path.join(f.packageDir, '.env'), 'must-not-be-masked-out-of-proof'); await f.replaceTar()
  await assert.rejects(prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_ARCHIVE' })
  await rm(path.join(f.packageDir, '.env')); await f.replaceTar()
  await writeFile(path.join(f.packageDir, 'binding.gyp'), '{}'); await f.replaceTar()
  await assert.rejects(prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: f.storageRoot, authorize: () => true }), { code: 'DEPENDENCY_UNSUPPORTED' })
  await rm(path.join(f.packageDir, 'binding.gyp')); await f.replaceTar()
  const environment = await prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: f.storageRoot, authorize: () => true })
  await assert.rejects(verifyNpmEnvironment({ environment, cwd: f.root, image }), { code: 'DEPENDENCY_STORAGE' })
  await mkdir(path.join(f.cwd, 'node_modules')); await writeFile(path.join(f.cwd, 'node_modules', 'keep'), 'user-data')
  await assert.rejects(prepareNpmWorkspace({ environment, cwd: f.cwd, image }), { code: 'DEPENDENCY_MOUNT' })
  assert.equal(await readFile(path.join(f.cwd, 'node_modules', 'keep'), 'utf8'), 'user-data')
  const proofPath = path.join(environment.directory, 'environment.json'), record = JSON.parse(await readFile(proofPath, 'utf8'))
  record.proof.treeHash = '0'.repeat(64); await writeFile(proofPath, JSON.stringify(record))
  await assert.rejects(restoreNpmEnvironment({ directory: environment.directory, storageRoot: f.storageRoot }), { code: 'DEPENDENCY_PROOF' })
  await assert.rejects(prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: path.join(f.cwd, 'private-store'), authorize: () => true }), { code: 'DEPENDENCY_STORAGE' })
  await assert.rejects(access(path.join(f.cwd, 'private-store')), { code: 'ENOENT' })
})

test('approved hooks cannot hide output from the environment seal behind private-path masks', opts, async t => {
  const f = await fixture(t, { hook: true, hookSource: "require('node:fs').writeFileSync('.env',Buffer.alloc(8192,65))" })
  const plan = await inspectNpmEnvironment({ cwd: f.cwd, image, registryOrigins: [f.origin], allowPrivate: true, limits: { unpackBytes: 4096 } })
  await assert.rejects(prepareNpmEnvironment({ plan, storageRoot: f.storageRoot, authorize: () => true, authorizeScripts: () => true }), { code: 'DEPENDENCY_HELPER' })
})

test('offline script approval binds package contents and image plan, not just an unchanged command string', opts, async t => {
  const f = await fixture(t, { hook: true })
  let oldApproval, newApproval
  const first = await prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: f.storageRoot, authorize: () => true,
    authorizeScripts: approval => { oldApproval = approval; return false } })
  await writeFile(path.join(f.packageDir, 'install.cjs'), "require('node:fs').writeFileSync('built','changed script must need a new approval')")
  await f.replaceTar()
  const second = await prepareNpmEnvironment({ plan: await f.inspect(), storageRoot: f.storageRoot, authorize: () => true,
    authorizeScripts: approval => { newApproval = approval; return approval.scriptsHash === oldApproval.scriptsHash } })
  assert.deepEqual(oldApproval.scripts, newApproval.scripts, 'the visible node install.cjs command itself did not change')
  assert.notEqual(oldApproval.planId, newApproval.planId)
  assert.notEqual(oldApproval.scriptsHash, newApproval.scriptsHash)
  assert.equal(first.status, 'needs_offline_build'); assert.equal(second.status, 'needs_offline_build')
  await assert.rejects(access(path.join(second.directory, 'job/node_modules/fixture-dep/built')), { code: 'ENOENT' })
})

test('real locked esbuild hook, build/test and TypeScript resolution share one isolated dependency environment', { ...opts, skip: !image || process.env.KKCODE_DEPENDENCY_LIVE !== '1', timeout: 240000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-esbuild-deps-')), cwd = path.join(root, 'source'), task = path.join(root, 'task'), storageRoot = path.join(root, 'store')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(cwd); await mkdir(storageRoot, { mode: 0o700 })
  const repositoryLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const entry = repositoryLock.packages['node_modules/esbuild']
  const project = { name: 'kk-real-esbuild', version: '1.0.0', dependencies: { esbuild: entry.version },
    scripts: { build: 'esbuild input.ts --bundle --platform=node --outfile=dist.cjs', test: 'node verify.cjs', install: 'node -e "process.exit(98)"' } }
  const packages = { '': { name: project.name, version: project.version, dependencies: project.dependencies } }
  for (const [key, value] of Object.entries(repositoryLock.packages)) if (key === 'node_modules/esbuild' || key.startsWith('node_modules/@esbuild/')) {
    packages[key] = { ...value, dev: false, resolved: value.resolved.replace('https://registry.npmmirror.com', 'https://registry.npmjs.org') }
  }
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(project))
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ name: project.name, version: project.version, lockfileVersion: 3, requires: true, packages }))
  await writeFile(path.join(cwd, 'input.ts'), 'export const answer: number = 42\n')
  await writeFile(path.join(cwd, 'verify.cjs'), "require('node:assert/strict').equal(require('./dist.cjs').answer,42);console.log('real-esbuild-offline-ok')")
  const plan = await inspectNpmEnvironment({ cwd, image, registryOrigins: ['https://registry.npmjs.org'] })
  assert.equal(plan.packages.filter(item => item.selected).length, 2)
  let scriptsApproved = 0
  const environment = await prepareNpmEnvironment({ plan, storageRoot, authorize: () => true, authorizeScripts: approval => {
    assert.deepEqual(approval.scripts.map(item => [item.path, item.event, item.command]), [['node_modules/esbuild', 'postinstall', 'node install.js']])
    scriptsApproved++; return true
  } })
  assert.equal(scriptsApproved, 1); assert.equal(environment.status, 'ready')
  await cp(cwd, task, { recursive: true }); await prepareNpmWorkspace({ environment, cwd: task, image })
  for (const argv of [['npm', 'run', 'build', '--offline'], ['npm', 'test', '--offline']]) {
    const result = await runStrictCommand({ workspaceDir: task, image, dependencyEnvironment: environment, argv })
    assert.equal(result.exitCode, 0, result.stderr)
  }
  if (process.env.KK_LSP_REAL_IMAGE === image) {
    await writeFile(path.join(task, 'type-check.ts'), "import { version } from 'esbuild'; export const checkedVersion: string = version;\n")
    await writeFile(path.join(task, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, strict: true, noEmit: true }, include: ['*.ts'] }))
    const service = await createLanguageService({ cwd: task, image, servers: createIsolatedLanguageServerConfigs(['typescript']), dependencyEnvironment: environment, mode: 'strict', timeoutMs: 30000, authorizeStart: () => true })
    t.after(() => service.close())
    const result = await service.inspect({ operation: 'diagnostics', path: 'type-check.ts' })
    assert.equal(result.diagnosticMode, 'typescript_sync'); assert.deepEqual(result.items, [])
    assert.deepEqual(result.isolation.dependencyEnvironment, { id: environment.id, planId: environment.planId, treeHash: environment.treeHash, imageId: environment.imageId })
  }
  t.diagnostic(JSON.stringify({ planId: plan.id, environmentId: environment.id, treeHash: environment.treeHash, imageId: environment.imageId, files: environment.files, bytes: environment.bytes, esbuild: entry.version, scriptsHash: environment.scriptsHash }))
})
