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

async function fixture(t, language) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-completion-feedback-'))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  const kernel = await createKernel({cwd, trustState: {trusted: true}, config: {config: {
    provider: {default: 'feedback-fixture', 'feedback-fixture': {default_model: 'fixture', retry_attempts: 0}},
    agent: {max_steps: 8, verify_completion: true}, permission: {level: 'yolo', rules: []},
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

for (const language of ['en', 'zh']) test(`shared guidance reaches the actual Plan system prompt without granting writes (${language})`, async () => {
  const prompt = await buildSystemPromptBlocks({mode: 'plan', model: 'fixture', cwd: process.cwd(), language, tools: [{name: 'bash'}]})
  const contract = prompt.blocks.find(block => block.label === 'assistant_contract').text
  assert.match(contract, /node --test/)
  assert.match(contract, language === 'zh' ? /只读\/Plan任务不得.*创建或修改/ : /Read-only\/Plan tasks must not create or edit/)
})
