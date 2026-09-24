import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { registerProvider } from '../src/kernel/provider/router.mjs'
import { runHybridLongAgent } from '../src/kernel/session/longagent-hybrid.mjs'
import { runStrictUltraStage } from '../src/kernel/session/strict-ultra-stage.mjs'
import { compressContext } from '../src/kernel/session/longagent-hybrid-helpers.mjs'
import { getSession, flushNow } from '../src/kernel/session/store.mjs'
import { runWithRuntime } from '../src/kernel/core/runtime-context.mjs'
import { createScriptedProvider, stagePlanFence, currentStageOf, ultraConfig } from './helpers/ultra-harness.mjs'
import { installBackgroundMock, restoreBackgroundMock } from './helpers/background-mock.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-ultra-roles-')), cwd = path.join(root, 'project')
  const previous = process.env.KKCODE_HOME, previousCwd = process.cwd()
  process.env.KKCODE_HOME = path.join(root, 'state'); await mkdir(process.env.KKCODE_HOME); await mkdir(cwd); process.chdir(cwd)
  t.after(async () => { restoreBackgroundMock(); await flushNow(); process.chdir(previousCwd); if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous; await rm(root, { recursive: true, force: true }) })
  return cwd
}
function roleConfig() {
  const state = ultraConfig({ providerName: 'main', gates: { smoke: { enabled: false } } }, { ultra: { max_rounds: 1, ledger: { enabled: false } } })
  for (const name of ['main', 'planner', 'writer']) state.config.provider[name] = { type: 'ultra-role-fixture', base_url: `https://${name}.fixture/v1`, default_model: `${name}-default`, stream: false, api_key_env: '', retry_attempts: 0 }
  state.config.models = { roles: { planning: { provider: 'planner', model: 'planning-role' }, implementation: { provider: 'writer', model: 'implementation-role' } }, ultra: { blueprint: 'legacy-must-not-win' } }
  return state
}

test('real Ultra planning/debug stages and background payload use explicit full routes without changing the parent session selection', { timeout: 15000 }, async t => {
  await fixture(t)
  const requests = [], payloads = []
  const plan = { planId: 'roles-plan', objective: 'Create the requested fixture module', goal: { objective: 'Create fixture', criteria: [{ kind: 'file_exists', text: 'fixture exists', spec: { path: 'src/fixture.mjs' } }] },
    stages: [{ stageId: 'implementation', name: 'Implementation', tasks: [{ taskId: 'write', prompt: 'Write the fixture module.', plannedFiles: ['src/fixture.mjs'], acceptance: ['src/fixture.mjs'] }] }] }
  const scripted = createScriptedProvider([{ stage: 1, reply: 'Repository reviewed.' }, { stage: 2, reply: stagePlanFence(plan) }, { stage: 4, reply: '[STAGE 4/4: DEBUGGING - COMPLETE]\n[TASK_COMPLETE]' }])
  registerProvider('ultra-role-fixture', { ...scripted, request: async input => {
    requests.push({ stage: currentStageOf(input), provider: input.provider, model: input.model, baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv })
    return scripted.request(input)
  } })
  installBackgroundMock({ behavior: payload => { payloads.push(payload); return null } })
  const sessionId = 'ultra-role-fixture-parent'
  await runHybridLongAgent({ prompt: 'Create src/fixture.mjs and verify it.', model: 'original-conversation', providerType: 'main', sessionId, configState: roleConfig(),
    baseUrl: 'https://original-override.fixture/v1', apiKeyEnv: 'ORIGINAL_CHANNEL_KEY', allowQuestion: false, output: { write() {} } })
  for (const stage of [1, 2]) {
    const request = requests.find(row => row.stage === stage)
    assert.ok(request, `stage ${stage} must actually execute`)
    assert.equal(request.provider, 'planner'); assert.equal(request.model, 'planning-role')
    assert.equal(request.baseUrl, 'https://planner.fixture/v1'); assert.equal(request.apiKeyEnv, '')
  }
  const debug = requests.find(row => row.stage === 4)
  assert.ok(debug); assert.equal(debug.provider, 'writer'); assert.equal(debug.model, 'implementation-role')
  assert.equal(debug.baseUrl, 'https://writer.fixture/v1')
  assert.ok(payloads.length); assert.equal(payloads[0].providerType, 'writer'); assert.equal(payloads[0].model, 'implementation-role')
  assert.equal(payloads[0].baseUrl, null); assert.equal(payloads[0].apiKeyEnv, null)
  const saved = await getSession(sessionId)
  assert.equal(saved.session.providerType, 'main'); assert.equal(saved.session.model, 'original-conversation')
  assert.equal(saved.session.mode, 'longagent')
})

test('strict stage direct entry resolves the implementation route before its real provider call', async t => {
  const cwd = await fixture(t)
  await writeFile(path.join(cwd, 'ready.txt'), 'fixture already present')
  const requests = []
  registerProvider('ultra-role-fixture', { request: async input => { requests.push(input); return { text: 'Stage execution finished.', usage: { input: 1, output: 1 }, toolCalls: [] } }, async *requestStream() {} })
  const result = await runWithRuntime({ cwd }, () => runStrictUltraStage({ stage: { stageId: 's', tasks: [{ taskId: 't', prompt: 'Inspect the prepared fixture.', plannedFiles: ['ready.txt'] }] },
    sessionId: 'strict-role-parent', model: 'original-conversation', providerType: 'main', configState: roleConfig(), baseUrl: 'https://original-override.fixture', apiKeyEnv: 'ORIGINAL_CHANNEL_KEY', toolContext: {}, objective: 'Check fixture', output: { write() {} } }))
  assert.equal(result.allSuccess, true)
  assert.equal(requests.length, 1); assert.equal(requests[0].provider, 'writer'); assert.equal(requests[0].model, 'implementation-role')
  assert.equal(requests[0].baseUrl, 'https://writer.fixture/v1'); assert.equal(requests[0].apiKeyEnv, '')
})

test('Ultra phase context compression uses its explicit compaction route only when compression is needed', async t => {
  const cwd = await fixture(t), requests = []
  const state = roleConfig()
  state.config.models.roles.compaction = { provider: 'planner', model: 'summary-role' }
  registerProvider('ultra-role-fixture', { request: async input => { requests.push(input); return { text: 'Verified phase summary.', usage: { input: 20, output: 5 }, toolCalls: [] } }, async *requestStream() {} })
  const sessionId = 'ultra-summary-parent'
  const options = { model: 'original-conversation', providerType: 'main', sessionId, configState: state, baseUrl: 'https://original-override.fixture', apiKeyEnv: 'ORIGINAL_CHANNEL_KEY' }
  await runWithRuntime({ cwd, sessionSelection: { sessionId, model: options.model, providerType: options.providerType, mode: 'longagent' } }, async () => {
    assert.equal(await compressContext('short', 100, options), 'short')
    assert.equal(requests.length, 0)
    assert.equal(await compressContext('Detailed engineering context. '.repeat(100), 100, options), 'Verified phase summary.')
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].provider, 'planner'); assert.equal(requests[0].model, 'summary-role')
  assert.equal(requests[0].baseUrl, 'https://planner.fixture/v1'); assert.equal(requests[0].apiKeyEnv, '')
  const saved = await getSession(sessionId)
  assert.equal(saved.session.model, 'original-conversation'); assert.equal(saved.session.providerType, 'main')
})
