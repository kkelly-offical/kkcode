import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createKernel} from '../src/kernel/kernel.mjs'
import {priorCompletionEvidence} from '../src/kernel/session/completion-history.mjs'
import {evaluateCompletionEvidence, classifyVerificationCommand} from '../src/kernel/session/completion-evidence.mjs'
import {bashTouchesProtected} from '../src/kernel/permission/protected-paths.mjs'

async function fixture(t, steps, permission = {level: 'yolo', rules: []}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kk-agent-continuity-'))
  const prior = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(root, 'state')
  const cwd = path.join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(path.join(cwd, 'wrong.txt'), 'unrelated\n')
  await writeFile(path.join(cwd, 'correct.txt'), 'before\n')
  await writeFile(path.join(cwd, 'check.test.mjs'), "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('correct.txt','utf8'),'after\\n');\n")
  const kernel = await createKernel({cwd, trustState: {trusted: true}, config: {config: {
    provider: {default: 'continuity-fixture', 'continuity-fixture': {default_model: 'fixture', retry_attempts: 0}},
    agent: {max_steps: 12, verify_completion: true}, permission,
    tool: {sources: {builtin: true, local: false, plugin: false, mcp: false}},
    session: {title_generation: false, recovery: false}, usage: {budget: {}}, ui: {markdown_render: false}
  }}})
  let requests = 0
  kernel.providers.registerProvider('continuity-fixture', {
    async request() {throw Error('No external requests')},
    async *requestStream() {
      const next = steps[requests++]
      if (!next) throw Error('Unexpected retry beyond scripted repair')
      if (typeof next === 'string') yield {type: 'text', content: next}
      else if (Array.isArray(next)) {
        for (const [index, call] of next.entries()) yield {type: 'tool_call', call: {id: `call-${requests}-${index}`, ...call}}
      } else yield {type: 'tool_call', call: {id: `call-${requests}`, ...next}}
    }
  })
  t.after(async () => {
    await kernel.shutdown()
    if (prior === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = prior
    await rm(root, {recursive: true, force: true})
  })
  return {kernel, cwd, requests: () => requests, run: (options = {}) => kernel.executeTurn({prompt: 'Change correct.txt to after, verify it, and deliver.', sessionId: 'continuity-owner', model: 'fixture', providerType: 'continuity-fixture', ...options})}
}

test('real zero-match edit followed by correction in another file remains recoverable in canonical history', async t => {
  const f = await fixture(t, [
    {name: 'read', args: {path: 'wrong.txt'}},
    {name: 'edit', args: {path: 'wrong.txt', before: 'before', after: 'after'}},
    {name: 'read', args: {path: 'correct.txt'}},
    {name: 'edit', args: {path: 'correct.txt', before: 'before', after: 'after'}},
    {name: 'bash', args: {command: 'node --test check.test.mjs 2>&1'}},
    'Changed the correct file; the test passed.'
  ])
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.verification.state, 'checks_observed')
  assert.equal(await readFile(path.join(f.cwd, 'wrong.txt'), 'utf8'), 'unrelated\n')
  const saved = await f.kernel.sessions.getSession('continuity-owner')
  const failed = saved.parts.find(p => p.tool === 'edit' && p.status === 'error')
  assert.equal(failed.mutationReceipt?.changed, false)
  // Rehydrate an unfinished turn to verify the receipt survives restart, not
  // merely the original process's WeakMap.
  const parts = saved.parts.filter(p => !(p.type === 'turn-outcome' && p.status !== 'running'))
  const carried = await priorCompletionEvidence({...saved, parts})
  assert.equal(evaluateCompletionEvidence({toolEvents: carried.toolEvents, cwd: f.cwd}).passed, true)
})

test('an old denied call does not suppress later completion repair', async t => {
  const f = await fixture(t, [
    {name: 'bash', args: {command: 'echo forbidden'}},
    {name: 'read', args: {path: 'correct.txt'}},
    {name: 'write', args: {path: 'correct.txt', content: 'after\n'}},
    'The work is complete.',
    {name: 'bash', args: {command: 'node --test check.test.mjs'}},
    'The actual test now passed.'
  ], {level: 'yolo', rules: [{tool: 'bash', pattern: '*forbidden*', action: 'deny'}]})
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(f.requests(), 6)
  assert.ok(result.toolEvents.some(e => e.code === 'PERMISSION_DENIED'))
})

test('untrusted no-change claims cannot hide a failed edit or unknown effect', () => {
  const event = {name: 'edit', args: {path: 'x'}, status: 'error', ok: false,
    metadata: {fileChanges: [], changed: false, mutationReceipt: {schema: 'kk.tool-mutation.v1', source: 'host', changed: false}}}
  assert.ok(evaluateCompletionEvidence({toolEvents: [event]}).failures.some(f => f.kind === 'failed_mutation'))
  event.metadata.outcomeUnknown = true
  assert.equal(evaluateCompletionEvidence({toolEvents: [event]}).state, 'outcome_unknown')
})

test('stderr merging preserves check identity, while masking expressions remain rejected', () => {
  assert.equal(classifyVerificationCommand('npm test 2>&1').id, classifyVerificationCommand('npm test').id)
  assert.ok(classifyVerificationCommand('npm run e2e'))
  for (const command of ['npm test | tail -5', 'npm test; echo done', 'npm test > result.log', 'npm test 0>&1', 'npm test 2>&3']) assert.equal(classifyVerificationCommand(command), null, command)
})

test('plain variable output does not turn an unrelated protected read into a write', () => {
  assert.equal(bashTouchesProtected('ls .kkcode 2>/dev/null; echo "HOME=$HOME"'), null)
  for (const command of ['echo $(rm -rf .kkcode)', 'echo `rm -rf .kkcode`', 'echo "${x:-$(rm -rf .kkcode)}"', 'ls .kkcode; echo bad > .kkcode/config.yaml']) assert.ok(bashTouchesProtected(command), command)
})

test('new user guidance stops undispatched writes while preserving tool pairs and completed work', async t => {
  const queue = [], take = () => queue.splice(0)
  take.hasPending = () => queue.length > 0
  const f = await fixture(t, [
    {name: 'read', args: {path: 'correct.txt'}},
    [{name: 'write', args: {path: 'correct.txt', content: 'after\n'}}, {name: 'write', args: {path: 'unwanted.txt', content: 'must not execute'}}],
    {name: 'bash', args: {command: 'node --test check.test.mjs'}},
    'Kept the completed change and verified it; did not create the cancelled deliverable.'
  ])
  const unsubscribe = f.kernel.events.subscribe(event => {
    if (event.sessionId === 'continuity-owner' && event.type === 'tool.finish' && event.payload?.tool === 'write' && event.payload.args?.path === 'correct.txt') queue.push('Do not create unwanted.txt. Verify the existing change and finish.')
  })
  t.after(unsubscribe)
  const result = await f.run({steerSource: take})
  assert.equal(result.status, 'completed')
  await assert.rejects(readFile(path.join(f.cwd, 'unwanted.txt')), {code: 'ENOENT'})
  assert.equal(await readFile(path.join(f.cwd, 'correct.txt'), 'utf8'), 'after\n')
  assert.ok(result.toolEvents.some(event => event.code === 'steering_pending'))
  const saved = await f.kernel.sessions.getSession('continuity-owner')
  assert.ok(saved.messages.some(message => message.contextKind === 'steering' && /Do not create/.test(message.content)))
})
