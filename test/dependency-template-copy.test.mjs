import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, symlink, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { copyDependencyTemplate } from '../evaluation/copy-dependency-template.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-template-copy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'template'), target = path.join(root, 'task', 'node_modules')
  await mkdir(path.join(source, '.bin'), { recursive: true }); await mkdir(path.join(source, 'runner'))
  await writeFile(path.join(source, 'runner', 'state.cjs'), 'exports.value = 0;\n')
  await writeFile(path.join(source, 'runner', 'cli.cjs'), "const state=require('./state.cjs');state.value=42;require(process.argv[2]);\n")
  return { root, source, target }
}
test('copied npm links and imported runner share the task-local module instance', async t => {
  const f = await fixture(t)
  try { await symlink('../runner/cli.cjs', path.join(f.source, '.bin', 'runner')) }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('host does not allow file symlink creation'); throw error }
  await copyDependencyTemplate(f.source, f.target)
  assert.equal(await readlink(path.join(f.target, '.bin', 'runner')), '../runner/cli.cjs')
  assert.equal(await realpath(path.join(f.target, '.bin', 'runner')), path.join(f.target, 'runner', 'cli.cjs'))
  const spec = path.join(path.dirname(f.target), 'spec.cjs')
  await writeFile(spec, "require('node:assert/strict').equal(require('./node_modules/runner/state.cjs').value,42);console.log('same module instance');\n")
  assert.match(execFileSync(process.execPath, [path.join(f.target, '.bin', 'runner'), spec], { encoding: 'utf8' }), /same module instance/)
  await writeFile(path.join(f.target, 'runner', 'state.cjs'), 'task local edit')
  assert.equal(await readFile(path.join(f.source, 'runner', 'state.cjs'), 'utf8'), 'exports.value = 0;\n')
  await assert.rejects(copyDependencyTemplate(f.source, f.target), /DESTINATION_EXISTS/)
})
test('regular launcher shims are copied without rewriting bytes on every platform', async t => {
  const f = await fixture(t)
  const shim = '@node "%~dp0..\\runner\\cli.cjs" %*\r\n'
  await writeFile(path.join(f.source, '.bin', 'runner.cmd'), shim)
  await copyDependencyTemplate(f.source, f.target)
  assert.equal(await readFile(path.join(f.target, '.bin', 'runner.cmd'), 'utf8'), shim)
})
test('an escaping template link fails before creating task dependencies', async t => {
  const f = await fixture(t)
  try { await symlink('../../outside', path.join(f.source, '.bin', 'runner')) }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('host does not allow file symlink creation'); throw error }
  await assert.rejects(copyDependencyTemplate(f.source, f.target), /EXTERNAL_LINK/)
  await assert.rejects(access(f.target), { code: 'ENOENT' })
})
