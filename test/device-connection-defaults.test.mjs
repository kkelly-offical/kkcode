import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverDeviceModels } from '../src/device/model-settings.mjs'

test('Base URL + API key fields discover a vLLM catalog without a supplied model or protocol', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-two-field-model-')), old = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = root
  t.after(async () => { if(old === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = old; await rm(root, { recursive: true, force: true }) })
  const requests = []
  const server = createServer((req, res) => { requests.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-qwen-27b', max_model_len: 262144 }] })) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const result = await discoverDeviceModels({ cwd: root }, { connection: { base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '' } })
  assert.equal(result.source, 'network')
  assert.equal(result.protocol, 'openai')
  assert.equal(result.models[0].id, 'fixture-qwen-27b')
  assert.equal(result.models[0].origin, 'auto')
  assert.deepEqual(requests, ['/v1/models'])
})
