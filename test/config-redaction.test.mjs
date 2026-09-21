import test from 'node:test'
import assert from 'node:assert/strict'
import { redactConfig } from '../src/config/redact.mjs'
test('configuration display recursively redacts keys and credential URLs without mutating config', () => {
  const config = { provider: { demo: { api_key: 'fixture-only', api_key_env: 'DEMO_API_KEY' } }, servers: [{ headers: { Authorization: 'Bearer fixture-only' } }] }
  const redacted = redactConfig(config)
  assert.equal(redacted.provider.demo.api_key, '[REDACTED]')
  assert.equal(redacted.provider.demo.api_key_env, 'DEMO_API_KEY')
  assert.equal(redacted.servers[0].headers.Authorization, '[REDACTED]')
  assert.equal(config.provider.demo.api_key, 'fixture-only')
  assert.ok(!redactConfig('https://person:fixture-only@example.com/?token=fixture-only').includes('fixture-only'))
})
