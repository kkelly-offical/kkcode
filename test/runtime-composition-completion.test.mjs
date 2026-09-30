import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/kernel.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-composition-completion-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(path.join(cwd, 'safe.mjs'), 'export const value = 1;\n')
  const kernel = await createKernel({ cwd, trustState: { trusted: true }, config: { config: {
    provider: { default: 'composition-fixture', 'composition-fixture': { default_model: 'fixture', retry_attempts: 0 } },
    agent: { max_steps: 6, verify_completion: true }, permission: { level: 'yolo', rules: [] },
    tool: { program: { enabled: true }, sources: { builtin: true, local: false, plugin: false, mcp: false } },
    session: { title_generation: false, recovery: false }, usage: { budget: {} }, ui: { markdown_render: false }
  } } })
  t.after(async () => {
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { kernel, cwd }
}

function composition(name, calls) {
  return { id: 'composed-operations', name, args: name === 'tool_batch' ? { calls }
    : { code: calls.map(call => `await tools.call(${JSON.stringify(call.name)}, ${JSON.stringify(call.args)});`).join('\n') } }
}

async function runComposition(kernel, name, calls) {
  let requests = 0
  kernel.providers.registerProvider('composition-fixture', {
    async request() { throw new Error('Only controlled streaming is enabled') },
    async *requestStream() {
      if (++requests === 1) yield { type: 'tool_call', call: composition(name, calls) }
      else yield { type: 'text', content: 'The implementation is complete.' }
    }
  })
  return kernel.executeTurn({ prompt: 'Implement the scoped file change and verify it.', sessionId: 'composition-owner', model: 'fixture', providerType: 'composition-fixture' })
}

for (const name of ['tool_batch', 'tool_program']) {
  test(`${name} leaf mutations remain unverified when only the wrapper result reaches the model`, async t => {
    const { kernel, cwd } = await fixture(t)
    const result = await runComposition(kernel, name, [{ name: 'write', args: { path: 'broken.mjs', content: 'syntax invalid {' } }])
    assert.equal(await readFile(path.join(cwd, 'broken.mjs'), 'utf8'), 'syntax invalid {')
    const saved = await kernel.sessions.getSession('composition-owner')
    assert.ok(saved.parts.some(part => part.type === 'tool-call' && part.tool === 'write' && part.status === 'completed'))
    assert.equal(result.status, 'incomplete', 'a governed wrapper cannot hide its real leaf mutation from the completion gate')
    assert.equal(result.verification?.passed, false)
    assert.ok(result.verification?.failures.some(failure => failure.kind === 'checks_required'))
  })

  test(`${name} host-recorded checks after a leaf mutation satisfy the same completion gate`, async t => {
    const { kernel } = await fixture(t)
    const result = await runComposition(kernel, name, [
      { name: 'write', args: { path: 'valid.mjs', content: 'export const value = 2;\n' } },
      { name: 'bash', args: { command: 'node --check valid.mjs' } }
    ])
    assert.equal(result.status, 'completed')
    assert.equal(result.verification?.passed, true)
    assert.equal(result.verification?.state, 'checks_observed', 'leaf checks are actual host evidence, not wrapper presentation text')
  })

  test(`${name} preserves leaf chronology and cannot verify a later write with an earlier check`, async t => {
    const { kernel, cwd } = await fixture(t)
    const result = await runComposition(kernel, name, [
      { name: 'bash', args: { command: 'node --check safe.mjs' } },
      { name: 'write', args: { path: 'broken.mjs', content: 'syntax invalid {' } }
    ])
    assert.equal(await readFile(path.join(cwd, 'broken.mjs'), 'utf8'), 'syntax invalid {')
    assert.equal(result.status, 'incomplete')
    assert.equal(result.verification?.passed, false)
    assert.ok(result.verification?.failures.some(failure => failure.kind === 'checks_required'))
  })
}
