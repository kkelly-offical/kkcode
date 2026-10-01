import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// Allows the same behavioral regression to run against the unchanged released
// source as a negative control. These providers never contact a real model.
const source = process.env.KKCODE_TEST_SOURCE_ROOT
  ? pathToFileURL(path.resolve(process.env.KKCODE_TEST_SOURCE_ROOT) + path.sep)
  : new URL('../', import.meta.url)
const { createKernel } = await import(new URL('src/kernel/kernel.mjs', source))
const { evaluateCompletionEvidence } = await import(new URL('src/kernel/session/completion-evidence.mjs', source))
const { buildSystemPromptBlocks } = await import(new URL('src/kernel/session/system-prompt.mjs', source))

const assertion = "import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('exact value and newline',()=>assert.equal(fs.readFileSync('result.txt','utf8'),'42\\n'));\n"
const customCheck = `node -e "if (require('node:fs').readFileSync('result.txt','utf8') !== '42\\n') throw Error('incorrect result')"`

async function fixture(t, language, {maxSteps = 8} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-completion-feedback-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  const kernel = await createKernel({cwd, trustState: {trusted: true}, config: {config: {
    provider: {default: 'feedback-fixture', 'feedback-fixture': {default_model: 'fixture', retry_attempts: 0}},
    agent: {max_steps: maxSteps, verify_completion: true}, permission: {level: 'yolo', rules: []},
    tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}},
    session: {title_generation: false, recovery: false}, usage: {budget: {}}, ui: {markdown_render: false}, language
  }}})
  t.after(async () => {
    await kernel.shutdown()
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    await rm(root, {recursive: true, force: true})
  })
  return {kernel, cwd}
}

for (const language of ['en', 'zh']) test(`real custom-output check receives actionable feedback and completes with a real assertion test (${language})`, async t => {
  const {kernel, cwd} = await fixture(t, language)
  let requests = 0, feedback = ''
  const call = (id, name, args) => ({type: 'tool_call', call: {id, name, args}})
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream(input) {
      requests++
      if (requests === 1) yield call('write-result', 'write', {path: 'result.txt', content: '42\n'})
      else if (requests === 2) yield call('custom-check', 'bash', {command: customCheck})
      else if (requests === 3) yield {type: 'text', content: 'The result is verified.'}
      else if (requests === 4) {
        feedback = JSON.stringify(input.messages.at(-1).content)
        assert.match(feedback, /checks_required/)
        assert.match(feedback, /node --test/)
        assert.match(feedback, language === 'zh' ? /真实测试/ : /real test/)
        yield call('write-assertion', 'write', {path: 'verify.test.mjs', content: assertion})
      } else if (requests === 5) yield call('assert-output', 'bash', {command: 'node --test verify.test.mjs'})
      else yield {type: 'text', content: 'The exact file value and newline passed the assertion test.'}
    }
  })
  const result = await kernel.executeTurn({prompt: 'Create result.txt with 42 and a newline, and verify the exact result.', sessionId: 'feedback-owner', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'completed')
  assert.equal(requests, 6)
  assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), '42\n')
  assert.equal(result.verification.passed, true)
  assert.equal(result.verification.state, 'checks_observed')
  assert.ok(result.toolEvents.some(event => event.name === 'bash' && event.args.command === customCheck && event.metadata.exitCode === 0))
  assert.ok(result.toolEvents.some(event => event.name === 'bash' && event.args.command === 'node --test verify.test.mjs' && event.metadata.exitCode === 0))
  assert.match(feedback, /checks_required/)
})

test('masked check repair feedback retains exact runner arguments without replaying the setup', async t => {
  const {kernel} = await fixture(t, 'en')
  let requests = 0, feedback = ''
  const exactCheck = 'node --test --test-reporter=spec verify.test.mjs'
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream(input) {
      requests++
      if (requests === 1) {
        yield {type: 'tool_call', call: {id: 'result', name: 'write', args: {path: 'result.txt', content: '42\n'}}}
        yield {type: 'tool_call', call: {id: 'test', name: 'write', args: {path: 'verify.test.mjs', content: assertion}}}
      } else if (requests === 2) yield {type: 'tool_call', call: {id: 'masked', name: 'bash', args: {command: exactCheck + ' || true'}}}
      else if (requests === 3) yield {type: 'text', content: 'The exact result passed.'}
      else if (requests === 4) {
        feedback = JSON.stringify(input.messages.at(-1).content)
        assert.match(feedback, /--test-reporter=spec/)
        assert.match(feedback, /verify.test.mjs/)
        assert.match(feedback, /not.*authorization/i)
        yield {type: 'tool_call', call: {id: 'direct', name: 'bash', args: {command: exactCheck}}}
      } else yield {type: 'text', content: 'The exact result passed the directly executed assertion suite.'}
    }
  })
  const result = await kernel.executeTurn({prompt: 'Create result.txt with 42 and a newline, and verify it.', sessionId: 'exact-check-owner', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'completed')
  assert.equal(requests, 5)
  assert.equal(result.verification.passed, true)
  assert.ok(result.toolEvents.some(event => event.name === 'bash' && event.args.command === exactCheck && event.metadata.exitCode === 0))
  assert.doesNotMatch(JSON.stringify(result.verification), /verify.test.mjs|--test-reporter=spec/)
})

test('guidance alone cannot turn repeated completion claims or a custom zero exit into successful acceptance', async t => {
  const {kernel, cwd} = await fixture(t, 'en')
  let requests = 0
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      requests++
      if (requests === 1) yield {type: 'tool_call', call: {id: 'write-result', name: 'write', args: {path: 'result.txt', content: '42\n'}}}
      else if (requests === 2) yield {type: 'tool_call', call: {id: 'custom-check', name: 'bash', args: {command: customCheck}}}
      else yield {type: 'text', content: 'All checks passed, complete.'}
    }
  })
  const result = await kernel.executeTurn({prompt: 'Create and verify the local output.', sessionId: 'no-check-owner', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'incomplete')
  assert.equal(result.stopReason, 'verification-incomplete')
  assert.equal(requests, 5)
  assert.equal(result.toolEvents.length, 2, 'no implicit verifier or replay after the hints')
  assert.equal(result.verification.passed, false)
  assert.match(result.verification.message, /node --test/)
  await assert.rejects(readFile(path.join(cwd, 'verify.test.mjs')), {code: 'ENOENT'})
})

test('failed-check feedback preserves check identity, chronology and unknown-effect blocking', () => {
  const write = {name: 'write', args: {path: 'result.txt'}, ok: true, status: 'completed'}
  const shell = (command, extra = {}) => ({name: 'bash', args: {command}, ok: true, status: 'completed', metadata: {exitCode: 0, started: true}, ...extra})
  const failed = shell('node --test original.test.mjs', {status: 'error', ok: false, metadata: {exitCode: 1}})
  const result = evaluateCompletionEvidence({toolEvents: [write, failed, shell('node --test unrelated.test.mjs')]})
  assert.equal(result.passed, false)
  assert.match(result.message, /same arguments, working directory and environment/)
  assert.ok(result.failures.some(failure => failure.kind === 'failed_check'))
  assert.equal(evaluateCompletionEvidence({toolEvents: [shell('node --test original.test.mjs'), write]}).passed, false)
  assert.equal(evaluateCompletionEvidence({toolEvents: [{...write, metadata: {outcomeUnknown: true}}, shell('node --test original.test.mjs')]}).state, 'outcome_unknown')
})

test('repairing a masked check uses its actual directory, not the shell launch directory', () => {
  const shell = (command, cwd = 'repo') => ({name: 'bash', args: {command, cwd}, status: 'completed', ok: true, metadata: {exitCode: 0, started: true}})
  const failed = shell('cd web && node --test suite.test.mjs | tail -10')
  assert.equal(evaluateCompletionEvidence({toolEvents: [failed, shell('node --test suite.test.mjs', 'repo/web')]}).passed, true)
  assert.equal(evaluateCompletionEvidence({toolEvents: [failed, shell('node --test suite.test.mjs', 'repo/api')]}).passed, false)
  assert.equal(evaluateCompletionEvidence({toolEvents: [shell('cd web\nnode --test suite.test.mjs || true'), shell('node --test suite.test.mjs', 'repo/web')]}).passed, false, 'a failed cd could have run the masked test in another directory')
})

test('a real edit repair is not blocked by duplicate paths in observability receipts', () => {
  const failed = {name: 'edit', args: {path: 'src/result.mjs'}, status: 'error', ok: false}
  const repaired = {name: 'edit', args: {path: 'src/result.mjs'}, status: 'completed', ok: true,
    metadata: {fileChanges: [{filePath: 'src/result.mjs'}], mutation: {filePath: 'src/result.mjs'}, mutations: [{filePath: 'src/result.mjs'}]}}
  const check = {name: 'bash', args: {command: 'node --test suite.test.mjs'}, status: 'completed', ok: true, metadata: {exitCode: 0, started: true}}
  assert.equal(evaluateCompletionEvidence({toolEvents: [failed, repaired, check]}).passed, true)
  assert.equal(evaluateCompletionEvidence({toolEvents: [failed, {...repaired, args: {path: 'other.mjs'}, metadata: {fileChanges: [{filePath: 'other.mjs'}]}}, check]}).passed, false)
})

test('a failed multi-file edit can be repaired one path at a time without clearing unrelated paths', () => {
  const failed = {name: 'edit', args: {changes: [{path: 'a.mjs'}, {path: 'b.mjs'}]}, status: 'error', ok: false}
  const repair = path => ({name: 'write', args: {path}, status: 'completed', ok: true, metadata: {fileChanges: [{filePath: path}], mutation: {filePath: path}}})
  const check = {name: 'bash', args: {command: 'node --test suite.test.mjs'}, status: 'completed', ok: true, metadata: {exitCode: 0, started: true}}
  assert.equal(evaluateCompletionEvidence({toolEvents: [failed, repair('a.mjs'), check]}).passed, false)
  assert.equal(evaluateCompletionEvidence({toolEvents: [failed, repair('a.mjs'), repair('b.mjs'), check]}).passed, true)
  assert.equal(evaluateCompletionEvidence({toolEvents: [{...failed, metadata: {started: false, operationAcknowledged: true}}, check]}).passed, false, 'untrusted metadata cannot manufacture the host pre-dispatch brand')
})

test('unknown process effects stop with retained evidence instead of autonomous repair nudges', async t => {
  const {kernel} = await fixture(t, 'en')
  let requests = 0
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      if (++requests === 1) yield {type: 'tool_call', call: {id: 'signal-exit', name: 'bash', args: {command: process.platform === 'win32' ? 'node missing-inspection-fixture.mjs' : 'kill -TERM $$'}}}
      else yield {type: 'text', content: 'All previous operations completed successfully.'}
    }
  })
  if (process.platform === 'win32') return t.skip('POSIX signal exit is covered by the Windows process-tree suites instead')
  const result = await kernel.executeTurn({prompt: 'Inspect the outcome and do not replay it.', sessionId: 'unknown-no-replay', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'incomplete')
  assert.equal(result.stopReason, 'inspection-required')
  assert.equal(result.verification.state, 'outcome_unknown')
  assert.equal(result.toolEvents.length, 1)
  assert.equal(requests, 2)
  assert.ok(result.verification.inspection.some(item => item.operationId))
  assert.match(result.reply, /session operations/)
  assert.doesNotMatch(result.reply, /kill -TERM/)
})

test('pre-dispatch schema rejection has no mutation and the real executor receipt survives history', async t => {
  const {kernel} = await fixture(t, 'en')
  let requests = 0
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      if (++requests === 1) yield {type: 'tool_call', call: {id: 'invalid-edit', name: 'edit', args: {path: 'never-created.mjs', changes: [{before: 'x', after: 'y'}]}}}
      else yield {type: 'text', content: 'The rejected edit did not run. No files were changed.'}
    }
  })
  const first = await kernel.executeTurn({prompt: 'Inspect the rejection without making changes.', sessionId: 'rejected-edit', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(first.status, 'completed')
  assert.equal(first.toolEvents[0].code, 'schema_invalid')
  assert.equal(first.toolEvents[0].metadata.started, false)
  const second = await kernel.executeTurn({prompt: 'Confirm no edit was applied.', sessionId: 'rejected-edit', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(second.status, 'completed')
})

test('provider failure preserves earlier verification failures in the returned result', async t => {
  const {kernel} = await fixture(t, 'en')
  let requests = 0
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      if (++requests === 1) yield {type: 'tool_call', call: {id: 'write', name: 'write', args: {path: 'result.txt', content: '42\n'}}}
      else if (requests === 2) yield {type: 'text', content: 'Complete.'}
      else throw Error('controlled provider allowance exhausted')
    }
  })
  const result = await kernel.executeTurn({prompt: 'Create the output and verify it.', sessionId: 'failed-provider-evidence', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'error')
  assert.equal(result.verification?.passed, false)
  assert.ok(result.verification.failures.some(failure => failure.kind === 'checks_required'))
})

for (const repair of [false, true]) test(`provider failure reports latest observed checks without declaring completion (repair=${repair})`, async t => {
  const {kernel} = await fixture(t, 'en')
  let requests = 0
  const call = (name, args) => ({type: 'tool_call', call: {id: 'error-evidence-' + requests, name, args}})
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      requests++
      if (requests === 1) yield call('write', {path: 'result.txt', content: '42\n'})
      else if (requests === 2) yield call('write', {path: 'verify.test.mjs', content: assertion})
      else if (requests === 3) yield call('bash', {command: repair ? 'node --test verify.test.mjs && node -e "process.stdout.write(\'checked\')"' : 'node --test verify.test.mjs'})
      else if (repair && requests === 4) yield {type: 'text', content: 'The task is complete.'}
      else if (repair && requests === 5) yield call('bash', {command: 'node --test verify.test.mjs'})
      else throw Error('controlled model request cap reached')
    }
  })
  const result = await kernel.executeTurn({prompt: 'Create and verify the output.', sessionId: 'latest-error-checks-' + repair, mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'error', 'observed checks do not fabricate a final assistant reply')
  assert.match(result.error, /controlled model request cap/)
  assert.equal(result.verification?.passed, true)
  assert.equal(result.verification?.state, 'checks_observed')
  assert.deepEqual(result.verification?.failures, [])
  assert.ok(result.verification.checks.some(check => check.status === 'passed'))
  assert.equal(requests, repair ? 6 : 4)
  assert.equal(result.toolEvents.length, repair ? 4 : 3, 'refresh only reads receipts, never reexecutes a check')
})

test('a later mutation stays unverified when a provider fails after an earlier passing check', async t => {
  const {kernel} = await fixture(t, 'en'); let requests = 0
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      requests++
      const call = (name, args) => ({type: 'tool_call', call: {id: 'later-mutation-' + requests, name, args}})
      if (requests === 1) yield call('write', {path: 'result.txt', content: '42\n'})
      else if (requests === 2) yield call('write', {path: 'verify.test.mjs', content: assertion})
      else if (requests === 3) yield call('bash', {command: 'node --test verify.test.mjs'})
      else if (requests === 4) yield call('write', {path: 'result.txt', content: '43\n'})
      else throw Error('controlled failure after later mutation')
    }
  })
  const result = await kernel.executeTurn({prompt: 'Keep all actual effects visible.', sessionId: 'error-after-green-edit', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'error'); assert.equal(result.verification.passed, false)
  assert.ok(result.verification.checks.some(check => check.status === 'passed'))
  assert.ok(result.verification.failures.some(failure => failure.kind === 'checks_required'))
  assert.equal(requests, 5)
})

test('step exhaustion reports current successful checks but remains incomplete without a final response', async t => {
  const {kernel} = await fixture(t, 'en', {maxSteps: 3}); let requests = 0
  kernel.providers.registerProvider('feedback-fixture', {
    async request() {throw Error('Streaming fixture only')},
    async *requestStream() {
      requests++
      const actions = [['write', {path: 'result.txt', content: '42\n'}], ['write', {path: 'verify.test.mjs', content: assertion}], ['bash', {command: 'node --test verify.test.mjs'}]]
      const [name, args] = actions[requests - 1]
      yield {type: 'tool_call', call: {id: 'step-terminal-' + requests, name, args}}
    }
  })
  const result = await kernel.executeTurn({prompt: 'Create and check the result.', sessionId: 'step-check-terminal', mode: 'assistant', model: 'fixture', providerType: 'feedback-fixture'})
  assert.equal(result.status, 'incomplete'); assert.equal(result.stopReason, 'max-steps')
  assert.equal(result.verification.passed, true); assert.equal(result.verification.state, 'checks_observed')
  assert.equal(requests, 3)
})

for (const language of ['en', 'zh']) test(`shared guidance reaches the actual Plan system prompt without granting writes (${language})`, async () => {
  const prompt = await buildSystemPromptBlocks({mode: 'plan', model: 'fixture', cwd: process.cwd(), language, tools: [{name: 'bash'}]})
  const contract = prompt.blocks.find(block => block.label === 'assistant_contract').text
  assert.match(contract, /node --test/)
  assert.match(contract, language === 'zh' ? /只读\/Plan任务不得.*创建或修改/ : /Read-only\/Plan tasks must not create or edit/)
})
