import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { recoveryCases } from '../evaluation/v1/recovery-cases.mjs'
import { runRecoveryScenario, verifyRecoveryEvidence } from '../evaluation/v1/recovery-drivers.mjs'
import { prepareBudgetProfile } from '../src/usage/budget-profiles.mjs'
import { createLocalFreeInferenceAuthorization, localFreePolicy } from '../src/usage/local-free.mjs'

for (const id of ['C02', 'C07', 'C09', 'C15']) test(`local-free ${id} preserves real zero-dollar authority across kernel/SQLite/process recovery`, {
  skip: process.platform !== 'linux' || !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000
}, async t => {
  const task = recoveryCases.find(value => value.id === id), root = await mkdtemp(path.join(os.tmpdir(), 'kk-free-recovery-'))
  const keyName = 'KKCODE_FREE_RECOVERY_KEY', previousKey = process.env[keyName]
  process.env[keyName] = 'synthetic-recovery-fixture-key'
  const seen = new Set(); let requests = 0
  const contentText = value => Array.isArray(value) ? value.map(block => block.text || '').join('\n') : String(value || '')
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    assert.equal(request.headers.authorization, `Bearer ${process.env[keyName]}`)
    const body = JSON.parse(Buffer.concat(chunks).toString()), last = contentText(body.messages.filter(value => value.role === 'user').at(-1)?.content)
    let message = { role: 'assistant', content: 'Fixture model turn done; host oracle remains authoritative.' }
    if (body.messages.some(value => value.role === 'system' && contentText(value.content).includes('conversation summarizer'))) message.content = '<summary>Keep all original constraints and continue.</summary>'
    else if (!seen.has(last)) {
      seen.add(last)
      const final = last.includes(task.stages[1].prompt), effect = ['C09', 'C15'].includes(id)
      const args = final ? { path: 'result.json', content: JSON.stringify(task.expectedResult) } : effect ? { path: 'effect-once.txt', content: 'once' } : { path: 'NOTES.md', content: task.prompt }
      message = { role: 'assistant', content: null, tool_calls: [{ id: `fixture-${requests}`, type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } }] }
    }
    requests++
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: 'free-recovery-fixture', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey; await rm(root, { recursive: true, force: true }) })
  const fixture = await prepareTask(task, { parent: root }), profile = { providerType: 'openai', model: 'free-recovery-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: keyName,
    contextLimit: 1000000, maxTokens: 1000, maxSteps: 8, pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
  const pricingFile = path.join(root, 'suite-prices.json')
  await writeFile(pricingFile, JSON.stringify({ models: { [profile.model]: profile.pricing } }))
  const state = { source: { userDir: root, userRaw: { usage: { pricing_file: pricingFile } } }, config: { provider: { default: 'evaluation', evaluation: {
    type: 'openai', base_url: profile.baseUrl, api_key_env: keyName, default_model: profile.model, context_limit: profile.contextLimit, max_tokens: profile.maxTokens
  } } } }
  let approvals = 0
  const authorization = await createLocalFreeInferenceAuthorization({ profile: await prepareBudgetProfile(state, { providerType: 'evaluation', model: profile.model }),
    baseUrl: profile.baseUrl, apiKeyEnv: keyName, maxRequests: 16, maxTokens: 10000000, authorize: async () => { approvals++; return true } })
  const execution = await runRecoveryScenario({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'), profile, image: process.env.KKCODE_STRICT_TEST_IMAGE,
    mode: 'live', budgetUsd: 0, deadlineAt: Date.now() + 80000, localFreeLimits: { requestLimit: 16, tokenLimit: 10000000 }, localFreeAuthorization: authorization })
  assert.equal(verifyRecoveryEvidence(task, execution).passed, true, JSON.stringify(execution.oracleChecks))
  assert.equal(execution.externalAuthorizedUsd, 0); assert.equal(execution.budget.budgetUsd, 0); assert.equal(execution.budget.spentUsd, 0)
  assert.ok(execution.budget.localFreePolicy); assert.equal(execution.budget.usedRequests, requests)
  assert.equal(execution.budget.localFreePolicy.id, localFreePolicy(authorization).id); assert.equal(approvals, 1)
  assert.ok(execution.budget.reservedTokens > 0)
  assert.equal(execution.modelError, false)
  if (task.expectedResult) assert.deepEqual(JSON.parse(await readFile(path.join(fixture.cwd, 'result.json'), 'utf8')), task.expectedResult)
  if (['C09', 'C15'].includes(id)) assert.equal(requests, 1, 'SIGKILL does not replenish the quota or replay the original effect')
})
