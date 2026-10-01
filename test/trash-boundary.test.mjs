import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {removeTool} from '../src/kernel/tool/file-ops.mjs'

for (const component of ['.kkcode', '.kkcode/trash']) test(`recoverable removal refuses a pre-existing ${component} directory alias before moving source bytes`, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'kk-trash-boundary-')), root = path.join(temp, 'project'), outside = path.join(temp, 'unrelated')
  t.after(() => rm(temp, {recursive: true, force: true}))
  await mkdir(root); await mkdir(outside); await writeFile(path.join(root, 'keep.txt'), 'must remain in project\n')
  if (component.includes('/')) await mkdir(path.join(root, '.kkcode'))
  await symlink(outside, path.join(root, component), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await removeTool.execute({path: 'keep.txt'}, {cwd: root})
  assert.match(typeof result === 'string' ? result : result.output, /error/i)
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'must remain in project\n')
  assert.deepEqual(await readdir(outside), [])
})

test('concurrent recoverable removals with identical basenames preserve every separate source', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-trash-concurrent-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(path.join(root, '.kkcode', 'trash'), {recursive: true})
  for (let i = 0; i < 12; i++) {await mkdir(path.join(root, String(i))); await writeFile(path.join(root, String(i), 'same.txt'), 'content-' + i)}
  const outputs = await Promise.all(Array.from({length: 12}, (_, i) => removeTool.execute({path: i + '/same.txt'}, {cwd: root})))
  const recovered = outputs.map(output => output.split('recoverable at ')[1])
  assert.equal(new Set(recovered).size, 12)
  for (let i = 0; i < 12; i++) assert.equal(await readFile(path.join(root, recovered[i]), 'utf8'), 'content-' + i)
})
