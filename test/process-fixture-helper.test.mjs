import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { nodeFixtureCommand } from './fixtures/process-script.mjs'
import { runManagedProcess } from '../src/kernel/tool/managed-process.mjs'

test('process fixture keeps quoted Unicode data separate from static code and shell arguments', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kk fixture 中文-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const value = 'A "quoted" line\n中文 \\ folder $value %value%'
  const source = "const fs = require('node:fs'); const { value } = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'data.json'), 'utf8')); fs.writeFileSync('observed.txt', value)"
  const command = await nodeFixtureCommand(cwd, source, { value })
  assert.match(command, /^node \.\/kkcode-process-fixture-[A-Za-z0-9]+\/process\.cjs$/)
  const script = command.slice('node '.length)
  assert.equal(await readFile(path.join(cwd, script), 'utf8'), source)
  const result = await runManagedProcess({ command: process.execPath, args: [script], cwd })
  assert.equal(result.exitCode, 0)
  assert.equal(await readFile(path.join(cwd, 'observed.txt'), 'utf8'), value)
})

test('two fixtures prepared in one cwd preserve independent code and data during overlapping execution', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kk shared fixture-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const firstSource = "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'data.json'), 'utf8')); setTimeout(() => fs.writeFileSync('first.txt', 'first code: ' + data.value), 120)"
  const secondSource = "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'data.json'), 'utf8')); setTimeout(() => fs.writeFileSync('second.txt', 'second code: ' + data.value), 80)"
  const first = await nodeFixtureCommand(cwd, firstSource, { value: 'first data' })
  const second = await nodeFixtureCommand(cwd, secondSource, { value: 'second data' })
  assert.notEqual(first, second, 'preparing a second fixture must not overwrite an unstarted background command')
  const results = await Promise.all([first, second].map(command => runManagedProcess({ command: process.execPath, args: [command.slice('node '.length)], cwd })))
  assert.deepEqual(results.map(result => result.exitCode), [0, 0])
  assert.equal(await readFile(path.join(cwd, 'first.txt'), 'utf8'), 'first code: first data')
  assert.equal(await readFile(path.join(cwd, 'second.txt'), 'utf8'), 'second code: second data')
})
