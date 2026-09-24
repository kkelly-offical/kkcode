import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { prepareTask } from '../evaluation/v1/runner.mjs'
import { repositoryCases } from '../evaluation/v1/repository-cases.mjs'
import { runLiveTask } from '../evaluation/v1/live-sdk.mjs'
import { prepareEvaluationLocalFreeAuthorization } from '../evaluation/v1/local-free-authorization.mjs'
import { localFreePolicy } from '../src/usage/local-free.mjs'

test('a real evaluation suite reuses one listener authorization across cases and refuses a replacement listener',
  { skip: !process.env.KKCODE_STRICT_TEST_IMAGE || process.platform !== 'linux', timeout: 120000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kk-evaluation-listener-')), previousHome = process.env.KKCODE_HOME
    process.env.KKCODE_HOME = path.join(root, 'initial-state')
    let calls = 0, replacementCalls = 0, server
    const respond = async (request, response) => {
      for await (const _chunk of request) { /* Consume this controlled fixture request. */ }
      calls++
      response.setHeader('Content-Type', 'text/event-stream')
      response.end(`data: ${JSON.stringify({ model: 'suite-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture response; not a task-quality result.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    }
    const close = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null } }
    try {
      server = createServer(respond); server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const port = server.address().port
      const profile = { providerType: 'openai', model: 'suite-fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: null,
        contextLimit: 131072, maxTokens: 4096, maxSteps: 1, pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
      const limits = { requestLimit: 4, tokenLimit: 1000000 }
      const authority = await prepareEvaluationLocalFreeAuthorization({ profile, limits, privateRoot: path.join(root, 'suite-authorization') })
      const expected = localFreePolicy(authority)
      const run = async (index, authorization = authority, allocation = limits) => {
        const task = repositoryCases[index], fixture = await prepareTask(task, { parent: root })
        return runLiveTask({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'), profile,
          image: process.env.KKCODE_STRICT_TEST_IMAGE, budgetUsd: 0, deadlineAt: Date.now() + 60000,
          localFreeLimits: allocation, localFreeAuthorization: authorization })
      }
      for (const index of [0, 1]) {
        const execution = await run(index)
        assert.equal(execution.modelError, false, JSON.stringify(execution.diagnostics))
        assert.equal(execution.budget.localFreePolicy.id, expected.id)
        assert.equal(execution.budget.budgetUsd, 0)
      }
      assert.equal(calls, 2)
      await assert.rejects(run(2, structuredClone(authority)), /JSON|布尔/)
      await assert.rejects(run(2, authority, { ...limits, requestLimit: 5 }), /silently changed/)
      assert.equal(calls, 2)
      await close()
      server = createServer((request, response) => { replacementCalls++; return respond(request, response) })
      server.listen(port, '127.0.0.1'); await once(server, 'listening')
      const outcome = await run(2).catch(error => ({ modelError: true, error }))
      assert.equal(outcome.modelError, true, 'a fresh task cannot silently approve a different listener')
      assert.equal(replacementCalls, 0, 'replacement listener receives no provider inference or count request')
    } finally {
      await close()
      if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
