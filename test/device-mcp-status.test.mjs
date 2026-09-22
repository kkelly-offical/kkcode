import test from 'node:test'
import assert from 'node:assert/strict'
import { publicMcpSummary } from '../src/device/mcp-status.mjs'
import { mcpLoadNotice } from '../apps/web/src/device-notices.mjs'

test('remote MCP summaries bound names/counts, discard diagnostics and avoid false healthy status', () => {
  const summary = publicMcpSummary({ ok: true, configured: 100, connected: -1, durationMs: Infinity, toolCount: 20, error: 'private diagnostic', failed: Array.from({ length: 70 }, () => ({ name: '\u001bserver\n', error: 'private secret', command: 'private command' })) })
  assert.equal(summary.failed.length, 50)
  assert.equal(summary.failedCount, 70)
  assert.equal(summary.ok, false)
  assert.equal(summary.connected, 0)
  assert.equal(summary.durationMs, 0)
  assert.equal(summary.truncated, true)
  assert.doesNotMatch(JSON.stringify(summary), /private|\\u001b|\\n/)
  assert.match(mcpLoadNotice({ ...summary, type: 'mcp.loaded' }), /70 项失败/)
  assert.equal(mcpLoadNotice({ type: 'mcp.loaded', configured: 0 }), '')
  assert.equal(mcpLoadNotice({ type: 'tool.start' }), '')
})
