import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRecoveryRuntime } from '../evaluation/v1/recovery-drivers.mjs'
import { createArtifactRecoveryObserver } from '../evaluation/v4/artifact-evidence.mjs'

// Deliberately independent of every evaluation catalog, task, expected result,
// probe, marker, and private run. This is a newly invented public experiment.
const CANARY = 'PUBLIC_SYNTHETIC_ARCHIVE_4826'
const PRODUCE = `node -e "process.stdout.write('${CANARY}\\n'+'synthetic trace\\n'.repeat(20000))"`
const AUXILIARY = `node -e "process.stdout.write('auxiliary readonly diagnostic\\n'.repeat(4000))"`
const enabled = { skip: process.platform !== 'linux' || !process.env.KKCODE_STRICT_TEST_IMAGE, timeout: 90000 }
const runFile = promisify(execFile)

async function fixture(t, { beforeOnly = false, foreignRead = false, unrelatedRead = false, noCommit = false, repeatAuxiliary = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kk-public-archive-proof-')), cwd = path.join(directory, 'workspace')
  const priorHome = process.env.KKCODE_HOME
  let runtime, phase = 0, step = 0, archiveId, responseId = 0
  const observer = createArtifactRecoveryObserver(), events = []
  const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `synthetic-${++responseId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      let message
      if (payload.messages.some(item => item.role === 'system' && String(item.content).includes('conversation summarizer'))) {
        message = { role: 'assistant', content: '<summary>The synthetic log has been archived; retrieve its original bytes using its retained reference.</summary>' }
      } else if (phase === 0) {
        if (step++ === 0) message = call('bash', { command: PRODUCE })
        else if (beforeOnly && step === 2) {
          archiveId = /art_[a-f0-9-]{36}/.exec(payload.messages.at(-1).content)?.[0]
          assert.ok(archiveId)
          message = call('artifact_read', { artifact_id: archiveId, limit: 100 })
        } else if (repeatAuxiliary && step === 2) message = call('bash', { command: AUXILIARY })
        else message = { role: 'assistant', content: 'Synthetic archive produced.' }
      } else if (step++ === 0) message = call('bash', { command: 'pwd' })
      else if (step === 2) message = call('bash', { command: "printf 'harmless diagnostic\\n'" })
      else if (step === 3 && !beforeOnly) message = call('artifact_read', { artifact_id: archiveId, limit: 100 })
      else if (step === 4 && repeatAuxiliary) message = call('bash', { command: AUXILIARY })
      else message = { role: 'assistant', content: 'Synthetic observation complete.' }
      const usage = { prompt_tokens: 100, completion_tokens: 20 }
      if (!payload.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: 'public-archive-fixture', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage })) }
      else {
        response.setHeader('content-type', 'text/event-stream')
        const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((item, index) => ({ ...item, index })) } : message
        response.end(`data: ${JSON.stringify({ model: 'public-archive-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ model: 'public-archive-fixture', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`)
      }
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: { message: error.message } })) }
  })
  t.after(async () => {
    try { await runtime?.coordinator.close() } finally {
      try { await runtime?.kernel.shutdown() } finally {
        await runtime?.store.close()
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
        if (priorHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = priorHome
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
  const repository = path.join(directory, 'repository')
  await mkdir(repository); await runFile('git', ['init', '-q', repository])
  await runFile('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Synthetic base'])
  await runFile('git', ['-C', repository, 'worktree', 'add', '--detach', cwd, 'HEAD'])
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const task = { id: 'public-archive-observation' }, limits = { budgetUsd: 10, deadlineAt: Date.now() + 80000 }
  runtime = await createRecoveryRuntime({ task, cwd, privateRoot: path.join(directory, 'private'), image: process.env.KKCODE_STRICT_TEST_IMAGE,
    limits, artifactObserver: observer, profile: { providerType: 'openai', model: 'public-archive-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: null, contextLimit: 1000000, maxTokens: 1000, maxSteps: 8, pricing: { input: 1, output: 1, cache_read: 1, cache_write: 1 } } })
  runtime.kernel.events.subscribe(event => events.push(event))
  runtime.run = await runtime.coordinator.start({ contract: { objective: 'Public synthetic archive observation.', allowedPaths: ['.'], allowedTools: ['bash', 'artifact_read'], allowedExternalActions: [],
    requiredCriteria: [{ id: 'public-observation', description: 'Host observes the original archive, compaction, and exact later read.' }] }, limits })
  await runtime.coordinator.execute({ runId: runtime.run.id, prompt: 'Produce the synthetic archive.', mode: 'agent' })
  for (let i = 0; i < 12; i++) await runtime.kernel.sessions.appendMessage(runtime.run.binding.sessionId, i % 2 ? 'assistant' : 'user', `Synthetic filler ${i}: ${'old context '.repeat(800)}`, { turnId: `filler-${i}` })
  const before = await runtime.kernel.sessions.getSession(runtime.run.binding.sessionId)
  const refs = before.messages.flatMap(message => message.artifactRefs || [])
  assert.ok(refs.length, 'actual strict output must create a host archive')
  archiveId = refs[0].id
  const compressed = noCommit ? { compacted: false } : await runtime.kernel.sessions.compactSession({ sessionId: runtime.run.binding.sessionId,
    providerType: 'evaluation', model: 'public-archive-fixture', configState: runtime.configState, keepRecentTurns: 1 })
  assert.equal(compressed.compacted, !noCommit)
  const after = await runtime.kernel.sessions.getSession(runtime.run.binding.sessionId)
  await observer.bindCompression(runtime, { before, after, committed: compressed.compacted })
  // Direct SDK compaction commits history but does not emit the loop caller's
  // session.compacted notification. Pin the actual committed boundary instead.
  const eventsAtCompression = events.length
  if (foreignRead || unrelatedRead) {
    const actor = { ...runtime.actor, sessionId: foreignRead ? 'foreign-session' : runtime.run.binding.sessionId, runId: foreignRead ? 'foreign-run' : runtime.run.id }
    const foreign = await runtime.artifacts.put({ actor, content: CANARY, source: { kind: 'system' } })
    archiveId = foreign.id
  }
  phase = 1; step = 0
  const execution = await runtime.coordinator.resume({ runId: runtime.run.id, prompt: 'Perform two harmless diagnostics, then inspect the original archive.', mode: 'agent' })
  return { runtime, observer, execution, events, eventsAtCompression, proof: await observer.verify(runtime) }
}

test('public archive fixture proves post-compaction reading while allowing other harmless Bash commands', enabled, async t => {
  const { proof, execution, events, eventsAtCompression } = await fixture(t)
  assert.ok(proof.checks.every(item => item.passed), JSON.stringify(proof))
  assert.equal(execution.run.actions.filter(action => action.kind === 'tool.bash').length, 3)
  assert.equal(proof.evidence.verifiedReads.length, 1)
  const selected = proof.evidence.verifiedReads[0]
  const action = execution.run.actions.find(item => item.id === selected.actionId)
  const finishIndex = events.findIndex(event => event.type === 'tool.finish' && event.payload?.invocationId === action.context.invocationId)
  assert.ok(finishIndex >= eventsAtCompression, 'the actual matching finish must occur after the committed compression boundary')
})

test('public archive proof rejects an actual replay of the original producing invocation', enabled, async t => {
  const { runtime, observer, proof } = await fixture(t)
  assert.ok(proof.checks.every(item => item.passed))
  const id = await observer.replayProducer(runtime), repeated = await observer.verify(runtime)
  assert.equal(repeated.evidence.actualExecutions.filter(item => item.operationId === id).length, 2)
  assert.equal(repeated.checks.find(item => item.name === 'bound-archive-producing-actions-not-reexecuted').passed, false)
})

test('public archive proof allows a fresh auxiliary readonly check that also produced an unrelated archive', enabled, async t => {
  const { runtime, observer, proof } = await fixture(t, { repeatAuxiliary: true })
  assert.equal(proof.evidence.boundary.sources.length, 2, 'both real archived outputs must be retained across compression')
  assert.equal(proof.evidence.verifiedReads.length, 1, 'only the original large archive was restored')
  assert.ok(proof.checks.every(item => item.passed), JSON.stringify(proof.checks))
  const auxiliary = proof.evidence.boundary.sources.find(source => !proof.evidence.restoredProducerIds.includes(source.producer.id))
  assert.ok(auxiliary)
  const id = await observer.replayProducer(runtime, auxiliary.ref.id), repeated = await observer.verify(runtime)
  assert.equal(repeated.evidence.actualExecutions.filter(item => item.operationId === id && item.completed).length, 2)
  assert.equal(repeated.checks.find(item => item.name === 'bound-archive-producing-actions-not-reexecuted').passed, false,
    'an actual same-logical-ID replay of the unrelated auxiliary command must still fail')
})

test('public archive proof rejects reading only before compression', enabled, async t => {
  const { proof } = await fixture(t, { beforeOnly: true })
  assert.equal(proof.checks.find(item => item.name === 'actual-artifact-read-after-context-compression').passed, false)
  assert.ok(proof.evidence.actualExecutions.some(item => item.kind === 'tool.artifact_read' && item.completed && item.sequence < proof.evidence.boundary.sequence))
})

test('public archive proof rejects a forged reference from a foreign actor scope', enabled, async t => {
  const { proof } = await fixture(t, { foreignRead: true })
  assert.equal(proof.checks.find(item => item.name === 'actual-artifact-read-after-context-compression').passed, false)
  assert.equal(proof.evidence.verifiedReads.length, 0)
})

test('public archive proof rejects a readable but unrelated artifact in the same actor scope', enabled, async t => {
  const { proof, execution } = await fixture(t, { unrelatedRead: true })
  assert.ok(execution.run.actions.some(action => action.kind === 'tool.artifact_read' && action.state === 'succeeded'))
  assert.equal(proof.checks.find(item => item.name === 'actual-artifact-read-after-context-compression').passed, false)
  assert.equal(proof.evidence.verifiedReads.length, 0)
})

test('public archive proof requires a real committed compression', enabled, async t => {
  const { proof } = await fixture(t, { noCommit: true })
  assert.equal(proof.evidence.boundary.committed, false)
  assert.ok(proof.checks.every(item => !item.passed))
})
