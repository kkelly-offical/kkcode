import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import * as evidence from '../src/kernel/session/completion-evidence.mjs'

const shell = command => ({name: 'bash', args: {command}, status: 'completed', ok: true, metadata: {exitCode: 0, started: true}})

test('failed check groups receive a matching ordered-chain repair, not misleading individual-check advice', () => {
  const command = 'node --test a.test.mjs && node --test b.test.mjs'
  const failed = {...shell(command), status: 'error', ok: false, metadata: {exitCode: 1, started: true}}
  const events = [failed, shell('node --test a.test.mjs'), shell('node --test b.test.mjs')]
  const verification = evidence.evaluateCompletionEvidence({toolEvents: events})
  assert.equal(verification.passed, false, 'separate runs do not prove the original ordered chain')
  for (const language of ['en', 'zh']) {
    const hint = evidence.completionRepairGuidance({verification, toolEvents: events, language})
    const records = JSON.parse(hint.match(/<check-repair-records>\n([\s\S]+)\n<\/check-repair-records>/)[1])
    assert.equal(records[0].execution, 'ordered-and-chain')
    assert.deepEqual(records[0].checks.map(check => check.argv.at(-1)), ['a.test.mjs', 'b.test.mjs'])
    assert.match(hint, language === 'zh' ? /相同顺序.*&&/ : /same order.*&&/)
  }
  assert.equal(evidence.evaluateCompletionEvidence({toolEvents: [...events, shell(command)]}).passed, true)
})

test('repair hints identify the exact masked check arguments and directory without replaying its setup', () => {
  const events = [shell('cd docs && python3 build.py && python3 -m unittest tests.test_docs -v 2>&1'), shell('cd docs && python3 -m unittest tests.test_docs')]
  const verification = evidence.evaluateCompletionEvidence({toolEvents: events, cwd: '/workspace/project'})
  assert.equal(verification.passed, false, 'presentation options retain exact check identity')
  assert.equal(typeof evidence.completionRepairGuidance, 'function')
  const guidance = evidence.completionRepairGuidance({verification, toolEvents: events, cwd: '/workspace/project'})
  assert.match(guidance, /tests.test_docs/)
  assert.match(guidance, /"-v"/)
  const records = JSON.parse(guidance.match(/<check-repair-records>\n([\s\S]+)\n<\/check-repair-records>/)[1])
  assert.equal(records[0].checks[0].cwd, path.resolve('/workspace/project', 'docs'))
  assert.doesNotMatch(guidance, /build.py|2>&1/)
  assert.match(guidance, /not.*(?:authorization|authority)/i)
  assert.equal(evidence.evaluateCompletionEvidence({toolEvents: [...events, shell('cd docs && python3 -m unittest tests.test_docs -v')], cwd: '/workspace/project'}).passed, true)
})

test('repair hints exclude source/output bodies and raw environment or credential arguments', () => {
  const first = shell('CI=private-environment-value node --test --token=credential-value verify.test.mjs || true')
  first.output = 'private-output-body'
  const events = [first]
  const verification = evidence.evaluateCompletionEvidence({toolEvents: events})
  assert.equal(typeof evidence.completionRepairGuidance, 'function')
  const guidance = evidence.completionRepairGuidance({verification, toolEvents: events})
  assert.match(guidance, /verify.test.mjs/)
  assert.match(guidance, /REDACTED/)
  assert.doesNotMatch(guidance, /private-environment-value|private-output-body|credential-value/)
  assert.doesNotMatch(JSON.stringify(verification), /verify.test.mjs|credential-value|private-environment-value/)
})

test('unknown execution outcomes never acquire a replay hint', () => {
  const event = shell('node --test verify.test.mjs || true')
  event.metadata.outcomeUnknown = true
  const events = [event], verification = evidence.evaluateCompletionEvidence({toolEvents: events})
  assert.equal(typeof evidence.completionRepairGuidance, 'function')
  assert.equal(evidence.completionRepairGuidance({verification, toolEvents: events}), '')
})

test('private repair hints redact separate credential options and URL credentials and never guess dynamic cwd', () => {
  const url = 'https://name:password@example.test/check?api_key=url-credential&token=second-credential'
  const events = [shell(`node --test --password separate-credential "${url}" verify.test.mjs || true`)]
  const verification = evidence.evaluateCompletionEvidence({toolEvents: events})
  const guidance = evidence.completionRepairGuidance({verification, toolEvents: events})
  assert.match(guidance, /verify.test.mjs/)
  assert.doesNotMatch(guidance, /separate-credential|url-credential|second-credential|name:password/)
  const dynamic = [shell('cd "$OTHER_PROJECT" && node --test verify.test.mjs || true')]
  assert.equal(evidence.completionRepairGuidance({verification: evidence.evaluateCompletionEvidence({toolEvents: dynamic}), toolEvents: dynamic}), '')
})

test('repair hints are bounded and forged or out-of-range failure locators cannot select arbitrary records', () => {
  const event = shell('node --test ' + 'a'.repeat(9000) + '.test.mjs || true')
  const events = [event], verification = evidence.evaluateCompletionEvidence({toolEvents: events})
  assert.equal(typeof evidence.completionRepairGuidance, 'function')
  assert.ok(evidence.completionRepairGuidance({verification, toolEvents: events}).length <= 6500)
  assert.equal(evidence.completionRepairGuidance({verification: {state: 'needs_verification', failures: [{kind: 'unverified_check', index: 0, id: 'forged-id'}]}, toolEvents: events}), '')
  assert.equal(evidence.completionRepairGuidance({verification: {state: 'needs_verification', failures: [{kind: 'failed_check', index: 99, id: 'forged-id'}]}, toolEvents: events}), '')
})
