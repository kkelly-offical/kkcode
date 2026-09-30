import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createKernel } from '../src/kernel/kernel.mjs'
import { createRunSpec } from '../src/kernel/orchestration/run-spec.mjs'

const exec = promisify(execFile)
const posix = process.platform !== 'win32'
const hasRg = posix && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0
const exists = file => access(file).then(() => true, () => false)

async function fixture(t, { git = false, allowRule = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-readonly-shell-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace'), bin = path.join(cwd, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(path.join(cwd, 'input.txt'), 'needle\n')
  const writer = '#!/bin/sh\nprintf changed > mutation.txt\nprintf "needle\\n"\n'
  for (const file of [path.join(cwd, 'preprocessor'), path.join(bin, 'cat')]) {
    await writeFile(file, writer)
    await chmod(file, 0o700)
  }
  if (git) {
    await exec('git', ['-c', 'init.templateDir=', 'init', '-q'], { cwd })
    await exec('git', ['config', 'diff.external', './preprocessor'], { cwd })
    await exec('git', ['add', 'input.txt'], { cwd })
    await writeFile(path.join(cwd, 'input.txt'), 'needle changed\n')
  }
  const kernel = await createKernel({ cwd, trustState: { trusted: true }, config: { config: {
    provider: { default: 'readonly-fixture', 'readonly-fixture': { default_model: 'fixture', retry_attempts: 0 } },
    agent: { max_steps: 5, verify_completion: true },
    permission: { level: 'yolo', rules: allowRule ? [{ tool: 'bash', action: 'allow' }] : [] },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
    session: { title_generation: false, recovery: false }, usage: { budget: {} }, ui: { markdown_render: false }
  } } })
  t.after(async () => {
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { kernel, cwd, bin }
}

async function executeReadonly(kernel, boundary, args) {
  let requests = 0
  kernel.providers.registerProvider('readonly-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() {
      if (++requests === 1) yield { type: 'tool_call', call: { id: 'readonly-shell', name: 'bash', args } }
      else yield { type: 'text', content: 'Read-only inspection concluded.' }
    }
  })
  const sessionId = 'readonly-probe'
  const runSpec = boundary === 'run-spec' ? createRunSpec({ sessionId, model: 'fixture', provider: 'readonly-fixture',
    role: { name: 'bounded-reader', permission: 'readonly', tools: ['bash'] },
    workspace: { cwd: kernel.cwd, root: kernel.cwd, writeScope: 'read-only' } }) : undefined
  const result = await kernel.executeTurn({ prompt: 'Inspect input.txt without changing files or running project executables.',
    mode: boundary === 'plan' ? 'plan' : 'agent', sessionId, model: 'fixture', providerType: 'readonly-fixture', runSpec })
  const tool = result.toolEvents.find(event => event.name === 'bash')
  assert.ok(tool, 'the controlled provider must exercise the actual Bash dispatch boundary')
  return { result, tool }
}

for (const boundary of ['plan', 'run-spec']) {
  for (const shellCommand of [
    'rg --pre ./preprocessor needle input.txt',
    "rg '--pre=./preprocessor' needle input.txt",
    'rg --pr\\e ./preprocessor needle input.txt'
  ]) test(`${boundary} denies ripgrep executable preprocessing: ${shellCommand}`, { skip: !hasRg }, async t => {
    const { kernel, cwd } = await fixture(t)
    const { tool } = await executeReadonly(kernel, boundary, { command: shellCommand })
    assert.equal(await exists(path.join(cwd, 'mutation.txt')), false, 'read-only search must not invoke the supplied executable')
    assert.notEqual(tool.status, 'completed')
  })

  test(`${boundary} denies a model-supplied PATH that replaces a nominally safe executable`, { skip: !posix }, async t => {
    const { kernel, cwd, bin } = await fixture(t)
    const { tool } = await executeReadonly(kernel, boundary, { command: 'cat input.txt', env: { PATH: bin } })
    assert.equal(await exists(path.join(cwd, 'mutation.txt')), false)
    assert.notEqual(tool.status, 'completed')
  })

  test(`${boundary} treats any model-supplied shell environment as outside its read-only proof`, { skip: !posix }, async t => {
    const { kernel } = await fixture(t)
    const { tool } = await executeReadonly(kernel, boundary, { command: 'cat input.txt', env: { SAFE_ONLY: '1' } })
    assert.notEqual(tool.status, 'completed')
  })

  test(`${boundary} denies explicit Git external-diff execution`, { skip: !posix }, async t => {
    const { kernel, cwd } = await fixture(t, { git: true })
    const { tool } = await executeReadonly(kernel, boundary, { command: 'git diff --ext-diff' })
    assert.equal(await exists(path.join(cwd, 'mutation.txt')), false)
    assert.notEqual(tool.status, 'completed')
  })

  test(`${boundary} still permits an ordinary file inspection`, { skip: !posix }, async t => {
    const { kernel, cwd } = await fixture(t)
    const { result, tool } = await executeReadonly(kernel, boundary, { command: 'cat input.txt' })
    assert.equal(tool.status, 'completed')
    assert.match(tool.output, /needle/)
    assert.equal(result.status, 'completed')
    assert.equal(await exists(path.join(cwd, 'mutation.txt')), false)
  })
}

test('Plan read-only ceiling cannot be widened by a general Bash allow rule', { skip: !posix }, async t => {
  const { kernel, cwd } = await fixture(t, { allowRule: true })
  const { tool } = await executeReadonly(kernel, 'plan', { command: 'printf changed > mutation.txt' })
  assert.equal(await exists(path.join(cwd, 'mutation.txt')), false)
  assert.notEqual(tool.status, 'completed')
})
