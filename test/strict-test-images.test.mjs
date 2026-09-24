import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runStrictCommand } from '../src/kernel/isolation/docker-executor.mjs'
import { createLanguageService } from '../src/kernel/lsp/service.mjs'

async function workspace(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kk-test-image-work-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

test('built strict-test image executes its exact Node/npm and timeout shell toolchain offline', {
  skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 60000
}, async t => {
  const cwd = await workspace(t)
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test check.cjs' } }))
  await writeFile(path.join(cwd, 'check.cjs'), "require('node:assert/strict').equal(3*7,21)")
  const result = await runStrictCommand({ image: process.env.KKCODE_STRICT_TEST_IMAGE, workspaceDir: cwd,
    command: 'test "$(node --version)" = v22.23.1 && test "$(npm --version)" = 10.9.8 && npm test && test ! -e /opt/kkcode-test/fake-lsp-server.mjs', readOnly: true })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /tests 1/)
  assert.equal(result.isolation.strict, true)
})

test('built separate LSP fixture target runs its copied stdio server through the real strict service', {
  skip: !process.env.KK_LSP_TEST_IMAGE, timeout: 60000
}, async t => {
  const cwd = await workspace(t)
  await writeFile(path.join(cwd, 'app.ts'), 'export const fixture = 1\n')
  const service = await createLanguageService({ cwd, image: process.env.KK_LSP_TEST_IMAGE, mode: 'strict',
    servers: { typescript: { command: '/usr/local/bin/node', args: ['/opt/kkcode-test/fake-lsp-server.mjs'] } }, authorizeStart: async () => true })
  t.after(() => service.close())
  const result = await service.inspect({ operation: 'symbols', path: 'app.ts' })
  assert.equal(result.items[0].name, 'readOnlySymbol')
  assert.deepEqual(result.isolation, { backend: 'docker', strict: true, network: 'none' })
  assert.match(result.sourceHash, /^[a-f0-9]{64}$/)
})
