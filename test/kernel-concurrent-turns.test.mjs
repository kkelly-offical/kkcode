import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/kernel/index.mjs'
import { runtimeCwd } from '../src/kernel/core/runtime-context.mjs'

test('concurrent real turns use instance providers, cwd, events and shutdown ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kkcode-parallel-')), previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const kernels = []
  try {
    for (const name of ['a', 'b']) {
      const cwd = path.join(root, name); await mkdir(cwd)
      const kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true } })
      kernel.configState.config.provider.default = 'fixture'
      kernel.configState.config.provider.fixture = { default_model: 'fixture', stream: false, retry_attempts: 0 }
      kernel.configState.config.skills.auto_seed = false
      kernel.configState.config.mcp.auto_discover = false
      kernel.configState.config.tool.sources = { builtin: false, local: false, plugin: false, mcp: false }
      kernel.providers.registerProvider('fixture', { async request() { await new Promise(r => setTimeout(r, 20)); return { text: `${name}:${runtimeCwd()}`, toolCalls: [], usage: { input: 1, output: 1 } } }, async *requestStream() { await new Promise(r => setTimeout(r, 20)); yield { type: 'text', content: `${name}:${runtimeCwd()}` } } })
      kernels.push(kernel)
    }
    const seen = [[], []]
    kernels.forEach((k, i) => k.events.subscribe(e => seen[i].push(e)))
    const results = await Promise.all(kernels.map((k, i) => k.executeTurn({ prompt: 'Hello', sessionId: `ses_parallel_${i}`, mode: 'assistant', model: 'fixture', providerType: 'fixture' })))
    assert.equal(results[0].reply, `a:${path.join(root, 'a')}`)
    assert.equal(results[1].reply, `b:${path.join(root, 'b')}`)
    assert.ok(seen[0].every(e => e.sessionId !== 'ses_parallel_1'))
    assert.ok(seen[1].every(e => e.sessionId !== 'ses_parallel_0'))
    await kernels[0].shutdown()
    const again = await kernels[1].executeTurn({ prompt: 'Again', sessionId: 'ses_parallel_1', mode: 'assistant', model: 'fixture', providerType: 'fixture' })
    assert.equal(again.reply, `b:${path.join(root, 'b')}`)
  } finally {
    await Promise.allSettled(kernels.map(k => k.shutdown()))
    if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
