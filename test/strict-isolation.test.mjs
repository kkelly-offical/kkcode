import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import { once } from 'node:events'
import { buildStrictDockerArgs, runStrictCommand, createDockerExecutionBackend, markStrictBuiltinTools, inspectStrictIsolation } from '../src/kernel/isolation/docker-executor.mjs'
import { createScopedGrantAuthority } from '../src/kernel/permission/scoped-grants.mjs'
import { isToolPreDispatchError, toolPreDispatchError } from '../src/kernel/core/execution-outcome.mjs'

const exec = promisify(execFile)
const image = process.env.KKCODE_STRICT_TEST_IMAGE
const real = { skip: !image, timeout: 60000 }
async function workspace(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kkcode-strict-test-'))
  const cwd = path.join(base, 'workspace')
  await mkdir(cwd)
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, cwd }
}

test('strict Docker profile has bounded, offline, readonly root and no ambient credentials', () => {
  const args = buildStrictDockerArgs({ name: 'kkcode-test', token: 'fixture', imageId: `sha256:${'a'.repeat(64)}`, workspace: '/task', argv: ['node', 'file with spaces.js'], readOnly: true })
  for (const item of ['--network', 'none', '--cap-drop', 'ALL', 'no-new-privileges=true', '--read-only', '--pids-limit', '--memory-swap', '--pull', 'never']) assert.ok(args.includes(item), item)
  assert.ok(args.includes('type=bind,src=/task,dst=/workspace,bind-propagation=rprivate,readonly'))
  assert.ok(args.includes('-i'))
  assert.deepEqual(args.slice(-2), ['node', 'file with spaces.js'])
  assert.ok(!args.some(value => /docker\.sock|\.ssh|--privileged|--env-file/.test(value)))
  assert.throws(() => createDockerExecutionBackend({ limits: { network: 1 } }), /不接受任意/)
})

test('strict backend refuses floating image tags and fine-grained contracts before execution', async t => {
  const { cwd } = await workspace(t)
  await assert.rejects(inspectStrictIsolation({ image: 'node:latest' }), error => error.operationNotStarted === true)
  const backend = createDockerExecutionBackend({ image: 'node:latest' })
  await assert.rejects(backend.ensureReady({ cwd, contract: { allowedPaths: ['src/a.js'] } }), /不会把细粒度/)
  await assert.rejects(backend.runCommand({ command: 'node', args: [], cwd }), /未绑定/)
})

test('pre-dispatch proof is private host provenance, not a code, flag or serialized error', () => {
  const plain = Object.assign(new Error('claimed'), { code: 'workspace_path_violation', operationNotStarted: true })
  assert.equal(isToolPreDispatchError(plain), false)
  const proof = toolPreDispatchError(plain)
  assert.equal(isToolPreDispatchError(proof), true)
  assert.equal(isToolPreDispatchError(JSON.parse(JSON.stringify(proof))), false)
  assert.equal(isToolPreDispatchError({ ...proof }), false)
})

test('scoped grants bind actor/task/target/version/parameters and are consumed once', async t => {
  const { base } = await workspace(t)
  const authority = await createScopedGrantAuthority({ rootDir: path.join(base, 'grants') })
  const input = { principal: 'account:one', taskId: 'task:one', action: 'forge.push', resource: 'https://example.test/repo?token=fixture-secret', resourceVersion: 'sha:a', operationId: 'op:one', args: { branch: 'work', secret: 'fixture-secret' }, expiresAt: Date.now() + 60000 }
  const grant = await authority.issue(input, { confirmedBy: 'account:one', confirmationId: 'approval:one' })
  for (const changed of [{ principal: 'account:two' }, { taskId: 'task:two' }, { resource: 'https://other.test' }, { resourceVersion: 'sha:b' }, { args: { branch: 'main' } }, { operationId: 'op:two' }]) {
    await assert.rejects(authority.verifyAndConsume(grant.token, { ...input, ...changed }), /不匹配/)
  }
  assert.ok(!Buffer.from(grant.token.split('.')[0], 'base64url').toString().includes('fixture-secret'))
  assert.ok(!(await readFile(path.join(base, 'grants', 'grants.json'), 'utf8')).includes('fixture-secret'))
  assert.equal((await authority.verifyAndConsume(grant.token, input)).id, grant.id)
  assert.equal((await authority.verifyContinuation(grant.token, input)).status, 'consumed')
  await assert.rejects(authority.verifyContinuation(grant.token, { ...input, operationId: 'other' }), /不匹配/)
  await assert.rejects(authority.verify(grant.token, input), /已使用/)
  await assert.rejects(authority.verifyAndConsume(grant.token, input), /已使用/)
})

test('scoped grants survive restarts, respect revocation/expiry and concurrent one-shot checks', async t => {
  const { base } = await workspace(t), rootDir = path.join(base, 'grants')
  let now = 10000
  const authority = await createScopedGrantAuthority({ rootDir, now: () => now })
  const input = { principal: 'u', taskId: 't', action: 'edit', resource: 'workspace', resourceVersion: 'v1', operationId: 'o', args: {}, expiresAt: 20000 }
  const confirmation = { confirmedBy: 'u', confirmationId: 'a' }
  const grant = await authority.issue(input, confirmation)
  const restarted = await createScopedGrantAuthority({ rootDir, now: () => now })
  const outcomes = await Promise.allSettled([authority.verifyAndConsume(grant.token, input), restarted.verifyAndConsume(grant.token, input)])
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  const revoked = await authority.issue(input, confirmation)
  await restarted.revoke(revoked.id)
  await assert.rejects(authority.verifyAndConsume(revoked.token, input), /撤销/)
  const expired = await authority.issue(input, confirmation)
  now = 21000
  await assert.rejects(authority.verifyAndConsume(expired.token, input), /过期/)
  await writeFile(path.join(rootDir, 'grants.json'), '{broken')
  now = 11000
  await assert.rejects(authority.verifyAndConsume(expired.token, input), /记录损坏/)
})

test('real Docker builds locally, masks secrets and has no host environment/socket/network', real, async t => {
  const { base, cwd } = await workspace(t)
  const canary = `fixture-${Date.now()}-must-not-leak`
  await writeFile(path.join(base, 'outside-secret'), canary)
  await writeFile(path.join(cwd, '.env'), canary)
  await mkdir(path.join(cwd, '.kkcode')); await writeFile(path.join(cwd, '.kkcode', 'config.json'), canary)
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test example.test.cjs' } }))
  await writeFile(path.join(cwd, 'example.test.cjs'), "require('node:assert/strict').equal(2+2,4)")
  const old = process.env.KKCODE_SECRET_CANARY
  process.env.KKCODE_SECRET_CANARY = canary
  t.after(() => { if (old === undefined) delete process.env.KKCODE_SECRET_CANARY; else process.env.KKCODE_SECRET_CANARY = old })
  const result = await runStrictCommand({ image, workspaceDir: cwd, command: `npm test && node -e 'const fs=require("node:fs"); if(process.env.KKCODE_SECRET_CANARY)process.exit(2); if(fs.existsSync("/var/run/docker.sock"))process.exit(3); if(fs.readFileSync(".env","utf8"))process.exit(4); console.log(JSON.stringify(require("node:os").networkInterfaces()))'` })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.ok(!`${result.stdout}${result.stderr}`.includes(canary))
  assert.ok(result.stdout.includes('tests 1'))
  assert.ok(!result.stdout.includes('eth0'))
  assert.equal(await readFile(path.join(cwd, '.env'), 'utf8'), canary)
  assert.equal(await readFile(path.join(base, 'outside-secret'), 'utf8'), canary)
  assert.equal(result.isolation.strict, true)
})

test('real strict file tools use container bridge, preserve read-before-edit and reject forged tools', real, async t => {
  const { cwd } = await workspace(t)
  await writeFile(path.join(cwd, 'a.txt'), 'before\n')
  const backend = createDockerExecutionBackend({ image })
  await backend.ensureReady({ cwd, contract: { allowedPaths: ['.'] } })
  const [read, edit, list] = markStrictBuiltinTools([{ name: 'read' }, { name: 'edit' }, { name: 'list' }])
  const invoke = () => { throw new Error('host tool must never execute') }
  await assert.rejects(backend.executeTool({ tool: { name: 'read' }, args: { path: 'a.txt' }, context: { cwd }, invoke }), /未经隔离/)
  assert.match((await backend.executeTool({ tool: read, args: { path: 'a.txt' }, context: { cwd }, invoke })).output, /before/)
  const changed = await backend.executeTool({ tool: edit, args: { path: 'a.txt', before: 'before', after: 'after' }, context: { cwd }, invoke })
  assert.match(changed.output, /已编辑/)
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after\n')
  await writeFile(path.join(cwd, 'a.txt'), 'concurrent edit\n')
  assert.equal((await backend.executeTool({ tool: edit, args: { path: 'a.txt', before: 'after', after: 'bad' }, context: { cwd }, invoke })).status, 'error')
  assert.ok((await backend.executeTool({ tool: list, args: {}, context: { cwd }, invoke })).output.includes('a.txt'))
  await assert.rejects(backend.executeTool({ tool: read, args: { path: '../outside' }, context: { cwd }, invoke }), /outside working/)
})

test('strict file paths share the exact /workspace namespace with Bash without widening filesystem scope', real, async t => {
  const { base, cwd } = await workspace(t)
  const backend = createDockerExecutionBackend({ image })
  await backend.ensureReady({ cwd, contract: { allowedPaths: ['.'] } })
  const names = ['bash', 'read', 'write', 'edit', 'patch', 'multiedit', 'list']
  const tools = Object.fromEntries(markStrictBuiltinTools(names.map(name => ({ name }))).map(tool => [tool.name, tool]))
  const call = (name, args) => backend.executeTool({ tool: tools[name], args, context: { cwd }, invoke: () => { throw new Error('host file implementation must not run') } })
  assert.equal((await call('bash', { command: 'pwd' })).output.trim(), '/workspace')
  assert.match((await call('write', { path: '/workspace/nested/subject.txt', content: 'one\ntwo\n' })).output, /已编辑/)
  assert.match((await call('read', { path: 'nested/subject.txt' })).output, /one/)
  assert.match((await call('edit', { path: '/workspace/nested/subject.txt', before: 'one', after: 'ONE' })).output, /已编辑/)
  assert.match((await call('patch', { path: '/workspace/nested/subject.txt', start_line: 2, end_line: 2, content: 'TWO' })).output, /已编辑/)
  assert.match((await call('multiedit', { changes: [{ path: '/workspace/nested/subject.txt', before: 'ONE', after: 'first' }, { path: '/workspace/second.txt', after: 'second' }] })).output, /已编辑/)
  assert.equal(await readFile(path.join(cwd, 'nested/subject.txt'), 'utf8'), 'first\nTWO\n')
  assert.match((await call('read', { path: '/workspace/nested/subject.txt' })).output, /first/)
  assert.match((await call('list', { path: '/workspace' })).output, /second.txt/)
  for (const target of ['/workspace/../escaped.txt', '/workspace/nested/../../escaped.txt', '/workspace-other/escaped.txt',
    '/workspace\\escaped.txt', '/workspace/..\\escaped.txt', '/workspace/.env', path.join(base, 'escaped.txt')]) {
    await assert.rejects(call('write', { path: target, content: 'forbidden' }), error => isToolPreDispatchError(error))
  }
  await assert.rejects(readFile(path.join(base, 'escaped.txt')), { code: 'ENOENT' })
  await writeFile(path.join(base, 'outside.txt'), 'unchanged')
  await symlink(base, path.join(cwd, 'escape'))
  await assert.rejects(call('read', { path: '/workspace/escape/outside.txt' }), error => isToolPreDispatchError(error))
  await assert.rejects(call('write', { path: '/workspace/escape/outside.txt', content: 'forbidden' }), error => isToolPreDispatchError(error))
  assert.equal(await readFile(path.join(base, 'outside.txt'), 'utf8'), 'unchanged')
})

test('an invoked host adapter cannot reuse an inner preflight proof to erase an outer effect', real, async t => {
  const { cwd } = await workspace(t), backend = createDockerExecutionBackend({ image })
  await backend.ensureReady({ cwd, contract: { allowedPaths: ['.'] } })
  const [tool] = markStrictBuiltinTools([{ name: 'todowrite' }])
  await assert.rejects(backend.executeTool({ tool, context: { cwd }, invoke: async () => {
    await writeFile(path.join(cwd, 'outer-effect.txt'), 'outer adapter ran')
    throw toolPreDispatchError(new Error('a later nested call never started'))
  } }), error => !isToolPreDispatchError(error) && error.operationNotStarted === false)
  assert.equal(await readFile(path.join(cwd, 'outer-effect.txt'), 'utf8'), 'outer adapter ran')
})

test('real strict read-only contract cannot mutate through Bash or file tools', real, async t => {
  const { cwd } = await workspace(t)
  await writeFile(path.join(cwd, 'a.txt'), 'unchanged')
  const backend = createDockerExecutionBackend({ image })
  await backend.ensureReady({ cwd, contract: { allowedPaths: [] } })
  const [bash, write] = markStrictBuiltinTools([{ name: 'bash' }, { name: 'write' }])
  const result = await backend.executeTool({ tool: bash, args: { command: 'echo changed > a.txt' }, context: { cwd } })
  assert.equal(result.status, 'error')
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'unchanged')
  await assert.rejects(backend.executeTool({ tool: write, args: { path: 'a.txt', content: 'bad' }, context: { cwd } }), error => error.operationNotStarted === true)
})

test('real strict execution rejects alias/hardlink escape and cancellation leaves no own container', real, async t => {
  const { base, cwd } = await workspace(t)
  await writeFile(path.join(base, 'outside'), 'outside')
  await symlink(path.join(base, 'outside'), path.join(cwd, 'alias'))
  await assert.rejects(runStrictCommand({ image, workspaceDir: cwd, command: 'cat alias' }), /escape/)
  await rm(path.join(cwd, 'alias'))
  await link(path.join(base, 'outside'), path.join(cwd, 'hardlink'))
  await assert.rejects(runStrictCommand({ image, workspaceDir: cwd, command: 'cat hardlink' }), /硬链接/)
  await rm(path.join(cwd, 'hardlink'))
  const abort = new AbortController()
  const result = await runStrictCommand({ image, workspaceDir: cwd, command: 'echo STARTED; sleep 30; echo SHOULD_NOT_RUN', signal: abort.signal, onStdout: () => abort.abort() })
  assert.equal(result.cancelled, true)
  assert.ok(!result.stdout.includes('SHOULD_NOT_RUN'))
  const containers = await exec('docker', ['ps', '-aq', '--filter', `id=${result.isolation.containerId}`])
  assert.equal(containers.stdout.trim(), '')
})

test('real verification argv is never shell-concatenated and output/time caps terminate the container', real, async t => {
  const { cwd } = await workspace(t)
  const backend = createDockerExecutionBackend({ image })
  await backend.ensureReady({ cwd, contract: { allowedPaths: ['.'] } })
  const literal = '$(touch /workspace/injected); spaces'
  const result = await backend.runCommand({ command: 'node', args: ['-e', 'console.log(process.argv[1])', literal], cwd, shell: false })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), literal)
  await assert.rejects(readFile(path.join(cwd, 'injected')), /ENOENT/)
  const timeout = await runStrictCommand({ image, workspaceDir: cwd, command: 'sleep 20', timeoutMs: 1000 })
  assert.equal(timeout.timedOut, true)
  assert.notEqual(timeout.exitCode, 0)
  const overflow = await runStrictCommand({ image, workspaceDir: cwd, argv: ['node', '-e', 'console.log("x".repeat(65536))'], limits: { max_output_bytes: 1024 } })
  assert.equal(overflow.overflow, true)
  assert.notEqual(overflow.exitCode, 0)
  for (const item of [timeout, overflow]) assert.equal((await exec('docker', ['ps', '-aq', '--filter', `id=${item.isolation.containerId}`])).stdout.trim(), '')
})

test('verification readonly sources cannot be replaced through parent rename, while new build output is writable', real, async t => {
  const { cwd } = await workspace(t)
  await mkdir(path.join(cwd, 'tests')); await writeFile(path.join(cwd, 'tests', 'a.js'), 'original')
  await writeFile(path.join(cwd, 'tests', '.env'), 'nested-secret-canary')
  const backend = createDockerExecutionBackend({ image, readOnlyPaths: ['tests/a.js'] })
  await backend.ensureReady({ cwd, contract: { allowedPaths: ['.'] } })
  const result = await backend.runCommand({ command: '/bin/sh', args: ['-c', 'if mv tests saved 2>/dev/null; then exit 9; fi; if echo fake > tests/a.js 2>/dev/null; then exit 8; fi; test ! -s tests/.env || exit 7; mkdir dist; echo built > dist/output'], cwd })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(await readFile(path.join(cwd, 'tests', 'a.js'), 'utf8'), 'original')
  assert.equal((await readFile(path.join(cwd, 'dist', 'output'), 'utf8')).trim(), 'built')
})

test('strict managed network requires host contract origins and refuses arbitrary HTTP effects/headers', real, async t => {
  const { cwd } = await workspace(t)
  let calls = 0
  const server = http.createServer((_request, response) => { calls++; response.end('fixture public data') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const { createToolRegistry } = await import('../src/kernel/tool/registry.mjs')
  const registry = createToolRegistry()
  const config = { data_policy: { web_origins: [origin] }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false }, http: { allow_private_hosts: true } } }
  await registry.initialize({ config, cwd, allowProjectSources: false })
  t.after(() => registry.shutdown())
  const tool = await registry.get('http_request'), context = { cwd, config }
  const closed = createDockerExecutionBackend({ image })
  await closed.ensureReady({ cwd, contract: { allowedPaths: [] } })
  assert.ok(!closed.allowedToolNames.includes('http_request'))
  await assert.rejects(closed.executeTool({ tool, args: { url: origin }, context }), /不允许/)
  const allowed = createDockerExecutionBackend({ image, networkOrigins: [origin] })
  await allowed.ensureReady({ cwd, contract: { allowedPaths: [] } })
  assert.match((await allowed.executeTool({ tool, args: { url: origin }, context })).output, /fixture public data/)
  for (const extra of [{ method: 'POST' }, { headers: { Authorization: 'fixture-secret' } }, { body: 'fixture' }]) await assert.rejects(allowed.executeTool({ tool, args: { url: origin, ...extra }, context }), /严格通用 HTTP/)
  assert.equal(calls, 1)
  const narrowed = await allowed.executeTool({ tool, args: { url: origin }, context: { ...context, config: { ...config, data_policy: { web_origins: [] } } } }).catch(error => error)
  assert.match(narrowed.message, /不允许/)
  assert.equal(calls, 1)
  assert.ok(!allowed.allowedToolNames.includes('browser_bridge'))
})
