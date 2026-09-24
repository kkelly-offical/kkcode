import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDelegatedKernel, isDelegatedKernel } from '../src/kernel/isolation/delegation-kernel.mjs'
import { registerProvider } from '../src/kernel/provider/router.mjs'

test('dedicated kernel never boots ambient executable extensions or copies ambient provider implementations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-delegated-kernel-')), cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  const prior = process.env.KKCODE_HOME; process.env.KKCODE_HOME = path.join(root, 'state')
  t.after(async () => { if (prior === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = prior; await rm(root, { recursive: true, force: true }) })
  const marker = path.join(root, 'MUST_NOT_RUN'), code = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export default {};`
  for (const folder of ['hooks', 'tools', 'skills', 'plugins']) {
    const dir = path.join(cwd, '.kkcode', folder); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'unsafe.mjs'), code)
  }
  registerProvider('ambient-unsafe', { request() { throw new Error('must not run') }, requestStream() { throw new Error('must not run') } })
  const configState = { config: { provider: { default: 'fixture', fixture: { type: 'openai', default_model: 'fixture' } },
    tool: { sources: { builtin: true, local: true, plugin: true, mcp: true }, local_dirs: ['.kkcode/tools'] }, skills: { enabled: true },
    permission: { level: 'manual', rules: [] }, agent: {}, session: {}, usage: { budget: {} } } }
  const kernel = await createDelegatedKernel({ cwd, configState, trustState: { trusted: true } })
  t.after(() => kernel.shutdown())
  assert.equal(isDelegatedKernel(kernel), true); assert.equal(isDelegatedKernel({ delegationIsolation: true }), false)
  await assert.rejects(kernel.executeTurn({ prompt: 'must not execute without a bound run' }), { code: 'delegation_context_required' })
  await assert.rejects(kernel.turns.executeTurn({ prompt: 'same public entry', toolContext: { durableRun: { runId: 'forged' } } }), { code: 'delegation_context_required' })
  assert.equal(kernel.providers.getProvider('ambient-unsafe'), null)
  await kernel.tools.initialize({ config: kernel.configState.config, cwd })
  await kernel.extensions.skills.initialize(kernel.configState.config, cwd)
  assert.equal(kernel.extensions.hooks.list().length, 0)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  await assert.rejects(kernel.bootExtensions(), { code: 'delegation_kernel_required' })
  await assert.rejects(kernel.applyTrustState({ trusted: true }), { code: 'delegation_kernel_required' })
  assert.throws(() => { kernel.configState.config.tool.sources.local = true }, TypeError)
  assert.equal(configState.config.tool.sources.local, true, 'ordinary host configuration is unchanged')
  const responsesConfig = structuredClone(configState)
  responsesConfig.config.provider.fixture.type = 'openai-responses'
  const responses = await createDelegatedKernel({ cwd, configState: responsesConfig, services: {}, trustState: { trusted: true } })
  t.after(() => responses.shutdown())
  assert.equal(isDelegatedKernel(responses), true)
  assert.ok(responses.providers.getProvider('openai-responses'))
  responsesConfig.config.provider.fixture = { type: 'gateway', protocol: 'responses', default_model: 'fixture' }
  const gateway = await createDelegatedKernel({ cwd, configState: responsesConfig, services: {}, trustState: { trusted: true } })
  t.after(() => gateway.shutdown())
  assert.equal(isDelegatedKernel(gateway), true)
  responsesConfig.config.provider.fixture.type = 'responses'
  await assert.rejects(createDelegatedKernel({ cwd, configState: responsesConfig, services: {}, trustState: { trusted: true } }), { code: 'delegation_kernel_required' })
})
