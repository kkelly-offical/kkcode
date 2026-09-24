import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { repositoryCases } from '../evaluation/v1/repository-cases.mjs'
import { runLiveTask, validateLiveProfile } from '../evaluation/v1/live-sdk.mjs'
import { evaluateCase } from '../evaluation/v1/oracles.mjs'

test('evaluation SDK adapter executes actual persistent tools against a zero-cost controlled HTTP fixture', { skip: !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kk-evaluation-sdk-'))
  const originalHome = process.env.KKCODE_HOME, originalKey = process.env.KKCODE_EVALUATION_TEST_KEY
  process.env.KKCODE_HOME = path.join(parent, 'initial-private')
  process.env.KKCODE_EVALUATION_TEST_KEY = 'synthetic-fixture-not-a-real-key'
  const task = repositoryCases[0]
  let requests = 0
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(payload.model, 'evaluation-local-fixture')
    assert.equal(request.headers.authorization, undefined)
    const index = requests++
    const message = index === 0 ? { role: 'assistant', content: null, tool_calls: [{ id: 'evaluation-read', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: 'subject.mjs' }) } }] }
      : index === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'evaluation-write', type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ path: 'subject.mjs', content: task.referenceFiles['subject.mjs'] }) } }] }
        : { role: 'assistant', content: 'Implementation prepared; independent oracle still required.' }
    response.setHeader('Content-Type', 'text/event-stream')
    const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : message
    response.end(`data: ${JSON.stringify({ model: 'evaluation-local-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ model: 'evaluation-local-fixture', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const fixture = await prepareTask(task, { parent })
    const profile = validateLiveProfile({ providerType: 'openai', model: 'evaluation-local-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: null, contextLimit: 131072, maxTokens: 4096, maxSteps: 3,
      pricing: { input: 1, output: 2, cache_read: 1, cache_write: 1 } })
    const execution = await runLiveTask({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'), profile,
      image: process.env.KKCODE_STRICT_TEST_IMAGE, budgetUsd: 1, deadlineAt: Date.now() + 60000 })
    assert.ok(requests >= 2, JSON.stringify({ requests, execution }))
    assert.ok(execution.durableRunId)
    assert.ok(execution.actions.some(action => action.kind === 'tool.write' && action.state === 'succeeded'), JSON.stringify(execution))
    assert.equal(await readFile(path.join(fixture.cwd, 'subject.mjs'), 'utf8'), task.referenceFiles['subject.mjs'])
    const oracle = await evaluateCase({ task, cwd: fixture.cwd, image: process.env.KKCODE_STRICT_TEST_IMAGE, baselineHashes: fixture.baselineHashes, execution })
    assert.equal(oracle.passed, true, JSON.stringify(oracle))
    assert.equal(execution.runState, 'waiting_input') // The oracle test is not automatic product delivery.
    assert.ok(execution.budget.spentUsd > 0) // Synthetic accounting only, no paid provider.
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (originalHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = originalHome
    if (originalKey === undefined) delete process.env.KKCODE_EVALUATION_TEST_KEY; else process.env.KKCODE_EVALUATION_TEST_KEY = originalKey
    await rm(parent, { recursive: true, force: true })
  }
})
