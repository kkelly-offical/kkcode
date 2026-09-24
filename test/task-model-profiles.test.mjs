import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveTaskModel, validateTaskModelRoles } from '../src/kernel/provider/task-model.mjs'
import { resolveProviderProfile } from '../src/kernel/provider/provider-profile.mjs'
import { validateConfig } from '../src/config/schema.mjs'
import { reviewSensitiveAction } from '../src/kernel/permission/auto-review.mjs'
import { refineSessionTitle } from '../src/kernel/session/session-title.mjs'
import { compactSession } from '../src/kernel/session/compaction.mjs'
import { registerProvider } from '../src/kernel/provider/router.mjs'
import { touchSession, appendMessage, getSession, flushNow } from '../src/kernel/session/store.mjs'
import { checkWorkspaceTrust } from '../src/kernel/permission/workspace-trust.mjs'
import { discoverModelsForProvider } from '../src/kernel/provider/model-catalog.mjs'
import { createModelCommand } from '../src/commands/model.mjs'

const base = () => ({ config: { provider: { default: 'other', conversation: { type: 'openai-compatible', base_url: 'https://conversation.fixture/v1', default_model: 'configured-default', api_key_env: '' },
  other: { type: 'anthropic', base_url: 'https://review.fixture/v1', default_model: 'review-model', api_key: 'fixture-role-credential' } },
  models: { main: 'must-not-replace-session', fast: 'must-not-be-inferred' } } })
const routeArgs = role => ({ role, providerType: 'conversation', model: 'actual-current-model', baseUrl: 'https://override.fixture/v1', apiKeyEnv: 'CURRENT_FIXTURE_KEY' })
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-role-profiles-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'home'); await mkdir(process.env.KKCODE_HOME)
  const cwd = path.join(root, 'project'); await mkdir(cwd)
  t.after(async () => { await flushNow(); if (old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  return cwd
}

test('all task roles default to the actual conversation, never fast, main or another provider default', async () => {
  for (const role of ['planning', 'implementation', 'review', 'compaction', 'title']) {
    const route = await resolveTaskModel(base(), routeArgs(role))
    assert.equal(route.providerType, 'conversation'); assert.equal(route.model, 'actual-current-model')
    assert.equal(route.source, 'conversation'); assert.equal(route.apiKeyEnv, 'CURRENT_FIXTURE_KEY')
  }
  const route = await resolveTaskModel(base(), { ...routeArgs('planning'), legacyModel: 'explicit-legacy-stage' })
  assert.equal(route.model, 'explicit-legacy-stage'); assert.equal(route.source, 'legacy-stage')
})

test('an explicit role overrides legacy stages, clears foreign endpoint credentials and obeys inherited data policy', async () => {
  const state = base(); state.config.models.roles = { review: { provider: 'other', model: 'explicit-review' } }
  const route = await resolveTaskModel(state, { ...routeArgs('review'), legacyModel: 'legacy' })
  assert.equal(route.providerType, 'other'); assert.equal(route.model, 'explicit-review')
  assert.equal(route.baseUrl, null); assert.equal(route.apiKeyEnv, null); assert.equal(route.overridden, true)
  state.source = { adminDataPolicy: { providers: ['conversation'], model_origins: ['https://conversation.fixture'] } }
  state.config.data_policy = { providers: ['conversation', 'other'] }
  await assert.rejects(resolveTaskModel(state, routeArgs('review')), error => error.code === 'data_policy_denied')
})

test('role config rejects unknown roles, inline secrets, implicit providers and malformed selections', () => {
  for (const roles of [{ unknown: null }, { review: 'provider/model' }, { review: { model: 'x' } }, { review: { provider: 'other', model: 'x', api_key: 'must-not-be-accepted' } }, { title: { provider: '__proto__', model: 'x' } }]) {
    assert.throws(() => validateTaskModelRoles(roles))
    assert.equal(validateConfig({ models: { roles } }).valid, false)
  }
  assert.equal(validateConfig({ models: { roles: { review: { provider: 'other', model: 'x' }, title: null } } }).valid, true)
})

test('untrusted project role changes cannot select a different otherwise user-owned model channel', async t => {
  const cwd = await fixture(t), state = base()
  state.config.models.roles = { review: { provider: 'other', model: 'explicit-review' } }
  state.source = { cwd, projectRaw: { models: { roles: state.config.models.roles } } }
  await assert.rejects(resolveTaskModel(state, routeArgs('review')), error => error.details.reason === 'workspace_untrusted')
  await checkWorkspaceTrust({ cwd, cliTrust: true, isTTY: false })
  assert.equal((await resolveTaskModel(state, routeArgs('review'))).model, 'explicit-review')
})

test('capability profile is read-only and distinguishes configured/catalog/inferred/unknown evidence without exposing credentials or query', async t => {
  await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('profile resolution must never make a network request'))
  const state = base()
  state.config.provider.other.base_url = 'https://review.fixture/private-path/v1?token=PRIVATE_QUERY_MARKER'
  state.config.provider.other.context_limit = 200000
  state.config.provider.other.max_tokens = 4096
  state.config.provider.other.native_compaction = true
  state.config.provider.model_capabilities = { 'claude-sonnet-fixture': { tools: true, streaming: true } }
  const first = await resolveProviderProfile(state, 'other', 'claude-sonnet-fixture')
  assert.equal(first.protocol, 'anthropic'); assert.equal(first.endpointOrigin, 'https://review.fixture')
  assert.deepEqual(first.capabilities.tools, { value: true, source: 'configuration' })
  assert.equal(first.capabilities.audio.source, 'unknown'); assert.equal(first.capabilities.nativeCompaction.value, true)
  assert.equal(first.context.limit, 200000); assert.equal(first.output.reserved, 4096)
  assert.equal(first.compatibility.endpointTested, false)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_QUERY_MARKER|fixture-role-credential|private-path/)
  assert.match(first.scope, /^[a-f0-9]{64}$/)
  state.config.provider.other.api_key = 'another-fixture-key'
  assert.notEqual((await resolveProviderProfile(state, 'other', 'claude-sonnet-fixture')).scope, first.scope)
  state.config.provider.other.api_key = 'fixture-role-credential'
  assert.notEqual((await resolveProviderProfile(state, 'other', 'other-model')).scope, first.scope)
  state.config.provider.other.base_url = 'https://another.fixture/v1'
  assert.notEqual((await resolveProviderProfile(state, 'other', 'claude-sonnet-fixture')).scope, first.scope)
})

test('real review and title helpers use only explicit configured role routes; denied review falls back to asking, not another model', async () => {
  const state = base(); state.config.models.roles = { review: { provider: 'other', model: 'explicit-review' }, title: { provider: 'other', model: 'explicit-title' } }
  const verdict = await reviewSensitiveAction({ configState: state, ...routeArgs('review'), sessionId: 'fixture', turnId: 't', prompt: 'Run requested tests', action: { tool: 'bash', command: 'npm test' }, request: async request => {
    assert.equal(request.providerType, 'other'); assert.equal(request.model, 'explicit-review'); assert.equal(request.baseUrl, null); assert.equal(request.apiKeyEnv, null)
    return { text: '{"decision":"allow","reason":"bounded fixture"}', usage: { input: 1, output: 1 } }
  } })
  assert.equal(verdict.decision, 'allow'); assert.equal(verdict.roleSource, 'configured-role')
  let session = { title: 'original' }, requested = 0
  const title = await refineSessionTitle({ configState: state, ...routeArgs('title'), sessionId: 'fixture', prompt: 'Create a fixture', deps: {
    getSession: async () => ({ session }), updateSessionIf: async (_id, expected, patch) => {
      if (Object.entries(expected).some(([key, value]) => session[key] !== value)) return null
      session = { ...session, ...patch }; return session
    }, emit: async () => {}, requestProvider: async request => { requested++; assert.equal(request.providerType, 'other'); assert.equal(request.model, 'explicit-title'); return { text: 'Explicit fixture title' } }
  } })
  assert.equal(title, 'Explicit fixture title'); assert.equal(requested, 1); assert.equal(session.titleModel, 'explicit-title')
  state.config.data_policy = { providers: ['conversation'] }
  const denied = await reviewSensitiveAction({ configState: state, ...routeArgs('review'), prompt: 'Run tests', action: {}, request: async () => assert.fail('denied role must not send data') })
  assert.equal(denied.decision, 'ask')
})

test('actual client compaction resolves its role and retains ordinary history CAS semantics', async t => {
  await fixture(t)
  const state = base()
  state.config.provider.summary = { type: 'summary-role-fixture', base_url: 'https://summary.fixture/v1', api_key_env: '', default_model: 'summary-model' }
  state.config.models.roles = { compaction: { provider: 'summary', model: 'selected-summary-model' } }
  let requested
  registerProvider('summary-role-fixture', { request: async input => { requested = input; return { text: 'A shorter verified continuation summary.', usage: { input: 20, output: 10 } } }, async *requestStream() {} })
  const sessionId = 'role-compaction-fixture'
  await touchSession({ sessionId, cwd: process.cwd(), mode: 'agent', providerType: 'conversation', model: 'current-model' })
  for (let i = 0; i < 12; i++) await appendMessage(sessionId, i % 2 ? 'assistant' : 'user', `${i}: ${'historical context '.repeat(150)}`, { turnId: `t${i}` })
  const result = await compactSession({ configState: state, sessionId, providerType: 'conversation', model: 'current-model' })
  assert.equal(result.compacted, true, result.reason)
  assert.equal(requested.provider, 'summary'); assert.equal(requested.model, 'selected-summary-model')
  assert.equal((await getSession(sessionId)).session.model, 'current-model')
})

test('catalog evidence stays endpoint/credential-scoped, and a directory response is not a compatibility certificate', async t => {
  await fixture(t)
  const state = base()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'opaque-deployment', capabilities: { tools: true, streaming: false, image: true }, context_length: 64000 }] }))
  await discoverModelsForProvider(state, { providerName: 'conversation', refresh: true })
  globalThis.fetch = async () => assert.fail('reading a profile does not re-fetch the catalog')
  const profile = await resolveProviderProfile(state, 'conversation', 'opaque-deployment')
  assert.deepEqual(profile.capabilities.tools, { value: true, source: 'catalog' })
  assert.deepEqual(profile.capabilities.streaming, { value: false, source: 'catalog' })
  assert.equal(profile.compatibility.endpointTested, false)
  state.config.provider.conversation.api_key = 'different-account-credential'
  const different = await resolveProviderProfile(state, 'conversation', 'opaque-deployment')
  assert.equal(different.capabilities.tools.value, null)
  assert.equal(different.catalog.available, false)
})

test('profile and route CLI diagnostics are non-mutating/no-network and redact endpoint paths and queries', async t => {
  await fixture(t)
  const state = base()
  state.config.provider.other.base_url = 'https://review.fixture/private/v1?api_key=PRIVATE_PROFILE_QUERY'
  state.config.models.roles = { review: { provider: 'other', model: 'explicit-review' } }
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify(state.config))
  t.mock.method(globalThis, 'fetch', async () => assert.fail('read-only diagnostics must not call a model'))
  const lines = []; t.mock.method(console, 'log', value => lines.push(value))
  await createModelCommand().parseAsync(['profile', '--provider', 'other', '--model', 'explicit-review', '--json'], { from: 'user' })
  assert.equal(JSON.parse(lines.at(-1)).endpointOrigin, 'https://review.fixture')
  await createModelCommand().parseAsync(['route', 'review', '--provider', 'conversation', '--model', 'current-model', '--json'], { from: 'user' })
  assert.equal(JSON.parse(lines.at(-1)).provider, 'other')
  assert.doesNotMatch(lines.join('\n'), /PRIVATE_PROFILE_QUERY|fixture-role-credential|\/private\//)
})
