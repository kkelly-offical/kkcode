import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createKernel } from '../src/kernel/kernel.mjs'
import { createRunSpec } from '../src/kernel/orchestration/run-spec.mjs'
import { createDurableRunBinding, withDurableRun } from '../src/kernel/orchestration/run-runtime.mjs'
import { createFixtureCleanup } from './helpers/fixture-cleanup.mjs'

for (const role of [null, { name: 'nested-coding', tools: ['read', 'write', 'agent_list'] }]) {
  test(`strict host tool ceiling survives ${role ? 'replacement role' : 'default role'} and model invention`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kk-strict-projection-'))
    const previous = process.env.KKCODE_HOME, cleanup = createFixtureCleanup(t)
    cleanup.remove(root)
    cleanup.defer(() => { if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous })
    process.env.KKCODE_HOME = path.join(root, 'state')
    await writeFile(path.join(root, 'input.txt'), 'retained')
    const kernel = await createKernel({ cwd: root, boot: false, trustState: { trusted: true }, config: { config: {
      provider: { default: 'projection_fixture', projection_fixture: { default_model: 'fixture', stream: false, retry_attempts: 0 } },
      agent: { max_steps: 4, verify_completion: false }, permission: { level: 'yolo', rules: [] },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      skills: { enabled: false, auto_seed: false }, git_auto: { enabled: false },
      session: { title_generation: false, recovery: false }, usage: { budget: {} }
    } } })
    cleanup.defer(() => kernel.shutdown())
    const requests = [], prepared = []
    kernel.providers.registerProvider('projection_fixture', {
      async request(input) {
        requests.push(input)
        return requests.length === 1
          ? { text: '', toolCalls: [{ id: 'invented-write', name: 'write', args: { path: 'input.txt', content: 'forbidden' } }], usage: {} }
          : { text: 'The host did not permit that tool.', toolCalls: [], usage: {} }
      }, async *requestStream() { throw new Error('stream disabled') }
    })
    const binding = createDurableRunBinding({ allowedToolNames: Object.freeze(['read']),
      async prepareTool(input) { prepared.push(input); throw new Error('Disallowed tool reached durable dispatch') },
      abort(error) { throw error }
    })
    const sessionId = 'projection'
    const result = await withDurableRun(binding, () => kernel.executeTurn({ sessionId, prompt: 'Read approved content only',
      ...(role ? { runSpec: createRunSpec({ sessionId, role, workspace: { root, cwd: root } }) } : {}) }))
    assert.ok(requests.length >= 1)
    assert.ok(requests.every(input => input.tools.length === 1 && input.tools[0].name === 'read'))
    assert.ok(requests.every(input => !String(input.system?.text || input.system).includes('### agent_list')))
    assert.equal(prepared.length, 0)
    assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'retained')
    assert.ok(result.toolEvents.some(event => event.name === 'write' && event.status === 'error' && /allowlist/.test(event.output)), JSON.stringify(result))
  })
}
