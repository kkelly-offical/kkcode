import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationFeedback } from '../src/kernel/session/verification-feedback.mjs'
import { evaluateCompletionEvidence } from '../src/kernel/session/completion-evidence.mjs'
import { markToolNotStarted } from '../src/kernel/core/execution-outcome.mjs'

const shell = command => ({name: 'bash', args: {command}, status: 'completed', ok: true, metadata: {exitCode: 0, started: true}})

test('early feedback deduplicates check identity across event indices without clearing failures', () => {
  const feedback = createVerificationFeedback(), events = [shell('node --test suite.test.mjs || true')]
  assert.match(feedback.observe(events, 0), /VERIFICATION FEEDBACK/)
  events.push(shell('node --test suite.test.mjs || true'))
  assert.equal(feedback.observe(events, 1), '')
  assert.equal(evaluateCompletionEvidence({toolEvents: events}).passed, false)
  const failed = {...shell('node --test suite.test.mjs'), status: 'error', ok: false, metadata: {exitCode: 1, started: true}}
  events.push(failed)
  assert.match(feedback.observe(events, 2), /VERIFICATION FEEDBACK/, 'a real failure is a distinct diagnostic from masked output')
  events.push(shell('node --test suite.test.mjs'))
  assert.equal(feedback.observe(events, 3), '')
  assert.equal(evaluateCompletionEvidence({toolEvents: events}).passed, true)
})

test('feedback stays silent for a repaired batch, ordinary editing and successful checks', () => {
  const feedback = createVerificationFeedback()
  assert.equal(feedback.observe([shell('node --test suite.test.mjs || true'), shell('node --test suite.test.mjs')], 0), '')
  assert.equal(feedback.observe([{name: 'write', args: {path: 'app.mjs'}, status: 'completed', ok: true}], 0), '')
  assert.equal(feedback.observe([shell('node --test suite.test.mjs')], 0), '')
  assert.equal(feedback.observe([shell('node generate.mjs')], 0), '')
  assert.equal(feedback.observe([shell('node --test suite.test.mjs || true')], 1), '', 'old checks are not fresh batch feedback')
})

test('unknown effects, incomplete history, unstarted and background checks get no autonomous repair advice', () => {
  for (const metadata of [{outcomeUnknown: true}, {terminationIncomplete: true}, {completionHistoryIncomplete: true}]) {
    const events = [{name: 'write', status: 'error', metadata}, shell('node --test suite.test.mjs || true')]
    assert.equal(createVerificationFeedback().observe(events, 1), '')
  }
  for (const event of [
    markToolNotStarted(shell('node --test suite.test.mjs || true')),
    {...shell('node --test suite.test.mjs'), metadata: {started: false}},
    {...shell('node --test suite.test.mjs'), metadata: {backgroundTask: 'running-check'}},
    {...shell('node --test suite.test.mjs'), status: 'cancelled'}
  ]) assert.equal(createVerificationFeedback().observe([event], 0), '')
})

test('private feedback excludes credentials and program bodies and remains byte bounded', () => {
  const event = shell('node prepare-private.mjs && node --test --token=private-token suite.test.mjs || true')
  event.args.env = {CI: 'private-environment-value'}
  event.output = 'private-program-output'
  const hint = createVerificationFeedback().observe([event], 0)
  assert.match(hint, /suite.test.mjs/)
  assert.doesNotMatch(hint, /private-token|private-environment-value|private-program-output|prepare-private.mjs/)
  assert.ok(Buffer.byteLength(hint) < 7500)
  const dynamic = shell('cd "$OTHER" && node --test suite.test.mjs || true')
  assert.equal(createVerificationFeedback().observe([dynamic], 0), '')
  assert.equal(createVerificationFeedback().observe([{...event, args: {...event.args, env: {PRIVATE_KEY: 'unsupported-environment-value'}}}], 0), '', 'unsupported environments never acquire repair locators')
})

test('turn-local guidance has a finite noise limit and does not leak into another turn', () => {
  const feedback = createVerificationFeedback(), events = []
  let notices = 0
  for (let i = 0; i < 20; i++) {
    events.push(shell(`node --test suite-${i}.test.mjs || true`))
    if (feedback.observe(events, i)) notices++
  }
  assert.equal(notices, 8)
  assert.equal(evaluateCompletionEvidence({toolEvents: events}).passed, false)
  assert.match(createVerificationFeedback().observe([events[0]], 0), /VERIFICATION FEEDBACK/)
})
