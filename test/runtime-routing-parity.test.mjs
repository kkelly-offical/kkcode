import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTaskMode } from '../src/kernel/session/longagent-utils.mjs'
import { resolvePromptMode } from '../src/kernel/session/engine.mjs'
import { extractPromptPathHints } from '../src/kernel/session/agent-transaction.mjs'

test('full-stack delivery with test commands is not misclassified as a bounded patch', () => {
  const prompt = 'Build a complete full-stack commerce service using Go APIs, React/TypeScript/Vite and PostgreSQL migrations. Read the repository, implement authentication, transactions and idempotency, then run npm test and go test ./... . Include a README that explains the architecture and how to continue development. Keep concurrent inventory updates correct and verify the mobile UI.'
  const classification = classifyTaskMode(prompt)
  assert.equal(classification.reason, 'cross_stack_delivery')
  assert.equal(classification.topology, 'heavy_multi_file_delivery')
  assert.equal(classification.continuity, 'new_transaction')
  for (const mode of ['agent', 'auto', 'yolo']) {
    const result = resolvePromptMode(prompt, mode)
    assert.equal(result.effectiveMode, 'assistant', 'task complexity never changes user approval/workflow selection')
    assert.equal(result.route.suggestion, 'longagent')
    assert.equal(result.route.reason, 'cross_stack_delivery')
  }
})

test('stack labels and package version slashes are not repository paths', () => {
  assert.deepEqual(extractPromptPathHints('React/TypeScript/Vite github.com/foo/v5 /tmp/app.go src/server/main.go README.md'), ['/tmp/app.go', 'src/server/main.go', 'README.md'])
})

test('local edits and explicit questions retain their lightweight execution choice', () => {
  assert.notEqual(classifyTaskMode('Read README.md, fix one command, then verify npm test.').mode, 'longagent')
  assert.equal(resolvePromptMode('How does a React frontend use Go and SQL?', 'auto').effectiveMode, 'assistant')
  assert.equal(resolvePromptMode('Build a full-stack project', 'plan').effectiveMode, 'plan')
})
