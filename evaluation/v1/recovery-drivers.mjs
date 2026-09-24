import path from 'node:path'
import { mkdir, writeFile, readFile, realpath, lstat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRunCoordinator, createDelegatedKernel, createDockerExecutionBackend, openRunStore, createArtifactStore } from '../../src/sdk/runs.mjs'
import { captureAcceptanceCandidate } from '../../src/kernel/session/acceptance-manifest.mjs'
import { withRequestBudget } from '../../src/usage/request-budget.mjs'
import { flushNow } from '../../src/kernel/session/store.mjs'
import { loadConfig } from '../../src/config/load-config.mjs'
import { sha256 } from './manifest.mjs'

const proofs = new WeakMap()
const proofBody = value => ({ ...value, diagnostics: undefined })
const guard = run => ({ runId: run.id, expectedRevision: run.revision, ownerId: run.ownerId, ownerEpoch: run.ownerEpoch })
const terminalUnknown = run => run.actions.some(action => ['prepared', 'unknown'].includes(action.state))
const summary = '<context-state>{"goal":"Continue the original task","key_decisions":["UTC; never publish; preserve original.txt; COMP-17; label B"],"evidence":["Existing files and durable receipts must not be replayed"]}</context-state><summary>Continue from the existing evidence.</summary>'
export const supportedRecovery = new Set(['pause_resume', 'coordinator_restart', 'cancel_inflight', 'detach_reattach', 'protocol_pair_restart', 'force_compaction', 'compaction_history_race', 'compaction_no_reduction', 'kill_after_prepare', 'receipt_write_failure', 'owner_epoch_takeover', 'candidate_drift_after_verify', 'artifact_context_restore', 'abort_tool_batch', 'process_sigkill_resume'])

export const isRecoveryEvidence = execution => proofs.has(execution) && proofs.get(execution).hash === sha256(proofBody(execution))
export function verifyRecoveryEvidence(task, execution) {
  const proof = proofs.get(execution), valid = isRecoveryEvidence(execution) && proof.taskHash === sha256(task) && execution.lifecycle === task.lifecycle
  return { passed: valid && proof.checks.length > 0 && proof.checks.every(check => check.passed === true), checks: valid ? structuredClone(proof.checks) : [{ name: 'host-recovery-evidence-authentic', passed: false }] }
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

/** A reference provider is used ONLY in system-selfcheck. It does not evaluate
 * model quality: the reference knows expected answers and is explicitly tagged.
 * All tools, SQLite recovery, compaction CAS and process faults remain real. */
async function referenceProvider(task) {
  let phase = 'first', sent = false, reads = 0, count = 0
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    count++
    const system = body.messages?.filter(item => item.role === 'system').map(item => item.content).join('\n') || ''
    let message = { role: 'assistant', content: 'Reference turn complete; host verification still required.' }
    if (system.includes('conversation summarizer')) message = { role: 'assistant', content: summary }
    else if (phase === 'first' && !sent) {
      sent = true
      let calls
      if (['cancel_inflight', 'kill_after_prepare', 'receipt_write_failure', 'owner_epoch_takeover', 'process_sigkill_resume'].includes(task.lifecycle)) calls = [call('first-effect', 'write', { path: 'effect-once.txt', content: 'once' })]
      else if (task.lifecycle === 'abort_tool_batch') calls = [call('read-original', 'read', { path: 'original.txt' }), call('read-package', 'read', { path: 'package.json' })]
      else if (task.lifecycle === 'detach_reattach') calls = [call('increment-once', 'bash', { command: `node -e "const fs=require('node:fs');const n=fs.existsSync('counter.txt')?Number(fs.readFileSync('counter.txt')):0;fs.writeFileSync('counter.txt',String(n+1))"` })]
      else if (task.lifecycle === 'artifact_context_restore') calls = [call('archive-long-log', 'bash', { command: 'cat large-log.txt' })]
      else if (task.lifecycle === 'protocol_pair_restart') calls = [call('read-fact', 'read', { path: 'original.txt' })]
      else calls = [call('note-constraint', 'write', { path: 'NOTES.md', content: task.prompt })]
      message = { role: 'assistant', content: null, tool_calls: calls }
    } else if (phase === 'last' && task.lifecycle === 'artifact_context_restore' && reads < 3) {
      reads++
      const id = JSON.stringify(body.messages).match(/art_[0-9a-f-]{36}/)?.[0]
      let cursor
      if (reads === 3) { try { cursor = JSON.parse(body.messages.filter(item => item.role === 'tool').at(-1)?.content).matches[0].readCursor } catch { /* Missing real cursor must fail the independent tail oracle. */ } }
      message = { role: 'assistant', content: null, tool_calls: [reads === 1 ? call('read-archive', 'artifact_read', { artifact_id: id, limit: 1000 }) : reads === 2 ? call('search-archive', 'artifact_search', { artifact_id: id, query: 'LAST=' }) : call('read-archive-tail', 'artifact_read', { artifact_id: id, cursor, limit: 1000 })] }
    } else if (phase === 'last' && !sent && task.expectedResult) {
      sent = true
      message = { role: 'assistant', content: null, tool_calls: [call('final-result', 'write', { path: 'result.json', content: JSON.stringify(task.expectedResult) })] }
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: `fixture-${count}`, model: 'recovery-fixture', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { profile: { providerType: 'openai', model: 'recovery-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: null,
    contextLimit: 1000000, maxTokens: 2000, pricing: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, maxSteps: 12 },
    next: () => { phase = 'last'; sent = false }, requests: () => count,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

async function privateControl(cwd, privateRoot) {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 })
  if ((await lstat(privateRoot)).isSymbolicLink()) throw new Error('Recovery control state cannot be a symlink')
  const canonical = await realpath(privateRoot), workspace = await realpath(cwd), relative = path.relative(workspace, canonical)
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) throw new Error('Recovery control state cannot be mounted inside the candidate')
  return canonical
}

/** Shared only with the trusted crash worker; never a model/tool API. */
export async function createRecoveryRuntime({ task, cwd, privateRoot, profile, image, limits, ownerId = 'evaluation-recovery', fault = null }) {
  const home = path.join(privateRoot, 'state'); process.env.KKCODE_HOME = home
  await mkdir(home, { recursive: true, mode: 0o700 })
  const prices = path.join(home, 'prices.json'), configFile = path.join(home, 'config.json')
  const config = { provider: { default: 'evaluation', evaluation: { type: profile.providerType === 'responses' ? 'openai-responses' : profile.providerType,
    base_url: profile.baseUrl, api_key: '', api_key_env: profile.apiKeyEnv || '', default_model: profile.model, context_limit: profile.contextLimit, max_tokens: profile.maxTokens, stream: false } },
    permission: { level: 'accept-edits', rules: [] }, agent: { default_mode: 'agent', max_steps: profile.maxSteps || 40 }, session: { title_generation: false, recovery: false },
    tool: { output_budget_ratio: 0.005, sources: { builtin: true, local: false, plugin: false, mcp: false } }, usage: { pricing_file: prices },
    skills: { enabled: false, auto_seed: false }, plugins: { enabled: false }, mcp: { servers: {} } }
  // A fresh private evaluator directory is host-owned. Reconstruct does not
  // reload or rewrite an editable project price file; persisted budgets prevail.
  for (const [file, content] of [[prices, { currency: 'USD', per_tokens: 1000000, models: { [profile.model]: profile.pricing } }], [configFile, config]]) {
    try { await writeFile(file, JSON.stringify(content), { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const state = await loadConfig(cwd)
  if (state.errors?.length || state.config.provider.default !== 'evaluation' || state.config.provider.evaluation.api_key) throw new Error('Recovery fixture configuration failed validation or explicit route isolation')
  const store = await openRunStore({ directory: path.join(privateRoot, 'runs') }), artifacts = createArtifactStore({ root: path.join(privateRoot, 'artifacts') })
  const kernel = await createDelegatedKernel({ cwd, configState: state, trustState: { trusted: true } })
  const strict = createDockerExecutionBackend({ image }), actor = { accountId: 'evaluation', projectId: task.id }
  const runtime = { store, kernel, artifacts, actor, configState: state, coordinator: null, run: null, limits, backend: strict }
  const backend = { ...strict, async executeTool(input) {
    await fault?.beforeTool?.(runtime, input)
    const result = await strict.executeTool({ ...input, invoke: () => {
      if (['artifact_read', 'artifact_search'].includes(input.tool.name)) return input.invoke()
      throw new Error('Recovery filesystem tools must never execute the host fallback')
    } })
    await fault?.afterTool?.(runtime, input, result)
    return result
  } }
  const originalPut = artifacts.put.bind(artifacts)
  artifacts.put = async input => { await fault?.beforeArtifact?.(runtime, input); return originalPut(input) }
  runtime.coordinator = createRunCoordinator({ kernel, store, artifacts, actor, ownerId, executionBackend: backend,
    leaseDirectory: path.join(privateRoot, 'leases'), grantDirectory: path.join(privateRoot, 'grants'),
    authorize: request => ['run.contract', 'run.takeover', 'run.tool', 'run.reconcile'].includes(request.kind) })
  return runtime
}

async function closeRuntime(runtime) {
  if (!runtime) return
  try { await runtime.coordinator?.close() } finally { try { await runtime.kernel?.shutdown() } finally { await runtime.store?.close() } }
}
const contractFor = task => ({ objective: task.prompt, allowedPaths: ['.'], allowedTools: ['read', 'write', 'edit', 'patch', 'list', 'bash', 'artifact_read', 'artifact_search'], allowedExternalActions: [],
  requiredCriteria: [{ id: 'recovery-oracle', description: 'Independent host must inspect real recovery transitions and preserved inputs' }] })
async function start(runtime, task) { runtime.run = await runtime.coordinator.start({ contract: contractFor(task), limits: runtime.limits }); return runtime.run }
const execute = (runtime, prompt, signal) => runtime.coordinator.execute({ runId: runtime.run.id, prompt, mode: 'agent', signal })

async function modelOperation(runtime, operation) {
  const budget = await runtime.store.getRunBudget({ runId: runtime.run.id })
  const result = await withRequestBudget({ budgetUsd: budget.budgetUsd, deadlineAt: budget.deadlineAt, alreadySpent: budget.spentUsd + budget.reservedUsd + budget.unknownUsd, profiles: budget.profiles,
    durable: { reserve: async input => { const run = await runtime.store.getRun(runtime.run.id); const result = await runtime.store.reserveModelBudget({ ...guard(run), ...input, kind: 'model' }); if (!result.fresh) throw new Error('Duplicate recovery request reservation'); return result },
      settle: async ({ requestId, amountUsd, status }) => runtime.store.settleModelBudget({ ...guard(await runtime.store.getRun(runtime.run.id)), requestId, amountUsd, status }) } }, operation)
  return result.result
}

async function pairs(runtime) {
  const session = await runtime.kernel.sessions.getSession(runtime.run.binding.sessionId), pending = new Set(), seen = new Set()
  for (const message of session.messages) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool_use') { if (seen.has(block.id) || pending.has(block.id)) return false; pending.add(block.id) }
    if (block.type === 'tool_result') { if (!pending.delete(block.tool_use_id)) return false; seen.add(block.tool_use_id) }
  }
  return pending.size === 0
}
const rejected = async callback => { try { await callback(); return null } catch (error) { return error.code || error.message } }
const exists = async file => { try { return (await lstat(file)).isFile() } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

async function compact(runtime, task, checks, operations, negativeControl = false) {
  const sessionId = runtime.run.binding.sessionId
  // An explicit fixture transcript makes compression deterministic without
  // duplicating real user messages or disguising generated answers as history.
  for (let i = 0; i < 12; i++) await runtime.kernel.sessions.appendMessage(sessionId, i % 2 ? 'assistant' : 'user', `Fixture long transcript ${i}: ${'preserved trace record '.repeat(600)}`, { turnId: `fixture-history-${i}` })
  const before = await runtime.kernel.sessions.getSession(sessionId), original = runtime.kernel.providers.getProvider(runtime.configState.config.provider.evaluation.type)
  let injected = false
  runtime.kernel.providers.registerProvider(runtime.configState.config.provider.evaluation.type, { ...original, async request(input) {
    const result = await original.request(input)
    if (!negativeControl && !injected && String(input.system).includes('conversation summarizer')) {
      injected = true
      if (task.lifecycle === 'compaction_history_race') await runtime.kernel.sessions.appendMessage(sessionId, 'user', 'Latest host-arriving requirement: label B. Keep this user correction.', { turnId: 'fixture-arriving-user' })
      if (task.lifecycle === 'compaction_no_reduction') return { ...result, text: 'Expanded fault-injected summary. '.repeat(20000) }
    }
    return result
  } })
  let result
  try { result = negativeControl && ['force_compaction', 'artifact_context_restore'].includes(task.lifecycle)
    ? { compacted: false, reason: 'Negative control deliberately did not run the required lifecycle' }
    : await modelOperation(runtime, () => runtime.kernel.sessions.compactSession({ sessionId, model: runtime.configState.config.provider.evaluation.default_model, providerType: 'evaluation', configState: runtime.configState, keepRecent: 2, keepRecentTurns: 1 })) }
  finally { runtime.kernel.providers.registerProvider(runtime.configState.config.provider.evaluation.type, original) }
  const after = await runtime.kernel.sessions.getSession(sessionId)
  if (task.lifecycle === 'compaction_history_race') {
    checks.push({ name: 'concurrent-user-append-preserved', passed: result.reasonCode === 'history_changed' && after.messages.length === before.messages.length + 1 && sha256(after.messages.slice(0, -1)) === sha256(before.messages) })
  } else if (task.lifecycle === 'compaction_no_reduction') {
    checks.push({ name: 'expanding-summary-keeps-history', passed: result.reasonCode === 'no_effective_reduction' && sha256(after.messages) === sha256(before.messages) })
  } else checks.push({ name: 'actual-client-compaction-committed', passed: result.compacted === true && after.messages.length < before.messages.length })
  operations.push({ kind: 'compactSession', result, faultInjected: ['compaction_history_race', 'compaction_no_reduction'].includes(task.lifecycle) })
  return { before, after }
}

/** Actual host lifecycle runner. All approval closures are evaluator authority,
 * all file effects use the real strict Docker backend, never model assertions. */
export async function runRecoveryScenario({ task, cwd, privateRoot, profile = null, image, budgetUsd = 0, deadlineAt = Date.now() + 120000, signal, mode = 'live', negativeControl = false }) {
  if (!supportedRecovery.has(task.lifecycle)) throw new Error('Unknown recovery lifecycle')
  if (!['live', 'system-selfcheck'].includes(mode)) throw new Error('Invalid recovery mode')
  if (mode === 'system-selfcheck' && (budgetUsd !== 0 || profile)) throw new Error('System selfcheck cannot authorize external model spending')
  if (mode === 'live' && (!profile || budgetUsd <= 0)) throw new Error('Live recovery requires an explicitly selected model and positive total allowance')
  if (negativeControl && mode !== 'system-selfcheck') throw new Error('Lifecycle negative controls are offline fixture-only, never live model quality evidence')
  privateRoot = await privateControl(cwd, privateRoot)
  const previousHome = process.env.KKCODE_HOME, reference = mode === 'system-selfcheck' ? await referenceProvider(task) : null
  profile = reference?.profile || profile
  const limits = { budgetUsd: reference ? 1 : budgetUsd, deadlineAt }, checks = [], operations = [], diagnostics = [], turns = []
  let runtime, beforeEventsHash, beforeEpoch, faultUsed = false, release, arrived
  const reached = new Promise(resolve => { arrived = resolve }), gate = new Promise(resolve => { release = resolve })
  try {
    const fault = {
      async afterTool(current, input) {
        if (faultUsed) return
        if (['cancel_inflight', 'detach_reattach', 'abort_tool_batch'].includes(task.lifecycle)) {
          faultUsed = true; arrived()
          if (task.lifecycle === 'detach_reattach' || negativeControl) await gate
          else await new Promise((_, reject) => { const abort = () => reject(Object.assign(new Error('Evaluation cancellation after a real tool'), { code: 'ABORT_ERR' })); if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, { once: true }) })
        } else if (task.lifecycle === 'owner_epoch_takeover' && !negativeControl) {
          faultUsed = true
          const row = await current.store.getRun(current.run.id)
          await current.store.claimRun({ runId: row.id, expectedRevision: row.revision, expectedOwnerId: row.ownerId, expectedOwnerEpoch: row.ownerEpoch, ownerId: 'evaluation-replacement', approval: { approved: true, actorId: 'evaluation-host', reason: 'Explicit ownership race injection' } })
        }
      },
      async beforeArtifact(_current, input) {
        if (negativeControl || task.lifecycle !== 'receipt_write_failure' || faultUsed || typeof input.content !== 'string') return
        let data; try { data = JSON.parse(input.content) } catch { return }
        if (data.actionId && data.result) { faultUsed = true; throw Object.assign(new Error('Evaluation receipt ENOSPC after actual effect'), { code: 'ENOSPC' }) }
      }
    }
    if (['kill_after_prepare', 'process_sigkill_resume'].includes(task.lifecycle)) {
      const workerEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', ...(profile.apiKeyEnv ? [profile.apiKeyEnv] : [])].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
      const worker = fork(fileURLToPath(new URL('./recovery-worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: workerEnv })
      let stderr = ''; worker.stderr.on('data', data => { if (stderr.length < 8000) stderr += data.toString() })
      const timer = setTimeout(() => worker.kill('SIGKILL'), Math.min(60000, deadlineAt - Date.now()))
      const abort = () => worker.kill('SIGKILL'); signal?.addEventListener('abort', abort, { once: true })
      try {
        worker.send({ task, cwd, privateRoot, profile, image, limits, negativeControl })
        const [notice] = await Promise.race([once(worker, 'message'), once(worker, 'exit').then(() => { throw new Error(`Recovery fault worker exited before the controlled boundary: ${stderr}`) })])
        if (!notice?.runId || notice.boundary !== task.lifecycle) throw new Error('Wrong recovery worker boundary')
        if (!negativeControl) worker.kill('SIGKILL')
        await once(worker, 'exit')
        runtime = await createRecoveryRuntime({ task, cwd, privateRoot, profile, image, limits })
        runtime.run = await runtime.store.getRun(notice.runId)
        beforeEventsHash = sha256(await runtime.store.events({ runId: notice.runId })); beforeEpoch = runtime.run.ownerEpoch
        const prior = runtime.run
        runtime.run = await runtime.coordinator.attach({ runId: prior.id })
        checks.push({ name: 'real-process-killed-after-durable-intent', passed: worker.signalCode === 'SIGKILL' && prior.actions.length === 1 && prior.actions[0].state === 'prepared' })
        checks.push({ name: 'fresh-owner-retains-unknown-without-replay', passed: runtime.run.ownerEpoch > beforeEpoch && terminalUnknown(runtime.run) && await rejected(() => runtime.coordinator.resume({ runId: prior.id })) === 'UNRESOLVED_ACTIONS' })
        checks.push({ name: 'independent-filesystem-proves-fault-boundary', passed: await exists(path.join(cwd, 'effect-once.txt')) === (task.lifecycle === 'process_sigkill_resume') })
        operations.push({ kind: 'real-process-SIGKILL', boundary: task.lifecycle, beforeState: prior.lastTurn?.status, afterState: runtime.run.lastTurn?.status })
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL') }
    } else {
      runtime = await createRecoveryRuntime({ task, cwd, privateRoot, profile, image, limits, fault })
      await start(runtime, task)
      beforeEpoch = runtime.run.ownerEpoch; beforeEventsHash = sha256(await runtime.store.events({ runId: runtime.run.id }))
      let unsubscribe, firstEvents = 0, secondEvents = 0
      if (task.lifecycle === 'detach_reattach') unsubscribe = runtime.kernel.events.subscribe(() => { firstEvents++ })
      const pending = execute(runtime, task.prompt, signal)
      if (['cancel_inflight', 'detach_reattach', 'abort_tool_batch'].includes(task.lifecycle)) {
        await Promise.race([reached, pending.then(() => { throw new Error('Model never reached required recovery tool boundary') })])
        if (task.lifecycle === 'detach_reattach') { if (!negativeControl) { unsubscribe(); unsubscribe = runtime.kernel.events.subscribe(() => { secondEvents++ }) } release() }
        else if (negativeControl) release()
        else await runtime.coordinator.cancel({ runId: runtime.run.id, reason: 'Evaluation controlled cancellation' })
      }
      let first
      try { first = await pending; turns.push(first.turn) } catch (error) { if (task.lifecycle !== 'owner_epoch_takeover') throw error; diagnostics.push(error.code || error.message) }
      unsubscribe?.()
      beforeEventsHash = sha256(await runtime.store.events({ runId: runtime.run.id }))
      let run = await runtime.store.getRun(runtime.run.id)
      if (task.lifecycle === 'cancel_inflight') {
        checks.push({ name: 'cancel-terminal-not-complete', passed: run.state === 'cancelled' && terminalUnknown(run) && faultUsed })
        checks.push({ name: 'cancelled-run-not-reexecuted', passed: !!await rejected(() => runtime.coordinator.resume({ runId: run.id })) && await readFile(path.join(cwd, 'effect-once.txt'), 'utf8') === 'once' })
      } else if (task.lifecycle === 'abort_tool_batch') {
        const saved = await runtime.kernel.sessions.getSession(run.binding.sessionId), toolCalls = saved.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use') : [])
        checks.push({ name: 'actual-two-read-batch-cancelled', passed: faultUsed && toolCalls.filter(call => call.name === 'read').length === 2 && run.state === 'cancelled' })
        checks.push({ name: 'cancelled-tool-history-remains-paired', passed: await pairs(runtime) })
        checks.push({ name: 'no-unproven-completion', passed: run.actions.every(action => action.effect === 'read') && run.state !== 'completed' })
      } else if (task.lifecycle === 'receipt_write_failure') {
        checks.push({ name: 'real-effect-survives-failed-receipt', passed: faultUsed && await readFile(path.join(cwd, 'effect-once.txt'), 'utf8') === 'once' && terminalUnknown(run) })
        checks.push({ name: 'receipt-failure-blocks-replay', passed: await rejected(() => runtime.coordinator.resume({ runId: run.id })) === 'UNRESOLVED_ACTIONS' && run.actions.length === 1 })
      } else if (task.lifecycle === 'owner_epoch_takeover') {
        checks.push({ name: 'actual-epoch-fence-rejects-old-host', passed: faultUsed && run.ownerEpoch > beforeEpoch && run.ownerId === 'evaluation-replacement' && await rejected(() => runtime.coordinator.execute({ runId: run.id, prompt: 'Must not run' })) === 'STALE_OWNER' })
        checks.push({ name: 'late-result-does-not-forge-success', passed: terminalUnknown(run) && run.actions.length === 1 && await readFile(path.join(cwd, 'effect-once.txt'), 'utf8') === 'once' })
      } else if (task.lifecycle === 'candidate_drift_after_verify') {
        const candidate = await captureAcceptanceCandidate(cwd), scopedActor = { ...runtime.actor, runId: run.id, sessionId: run.binding.sessionId }
        const proof = await runtime.artifacts.put({ actor: scopedActor, content: JSON.stringify({ candidate, verifiedOriginal: await readFile(path.join(cwd, 'original.txt'), 'utf8') }), source: { kind: 'system' } })
        run = await runtime.store.setCandidate({ ...guard(run), candidateHash: candidate.treeFingerprint })
        run = await runtime.store.recordVerification({ ...guard(run), receipt: { id: 'host-checked-candidate', criterionId: 'recovery-oracle', candidateHash: candidate.treeFingerprint, status: 'passed', evidenceRefs: [proof.id] } })
        // Drift is an explicit host fixture mutation, never an agent's assertion.
        if (!negativeControl) await writeFile(path.join(cwd, 'after-verification.txt'), 'host fault: different candidate\n', { flag: 'wx' })
        const current = await captureAcceptanceCandidate(cwd)
        run = await runtime.store.setCandidate({ ...guard(run), candidateHash: current.treeFingerprint })
        checks.push({ name: 'candidate-change-invalidates-old-verification', passed: current.treeFingerprint !== candidate.treeFingerprint && !run.verifications.some(item => item.status === 'passed' && item.candidateHash === current.treeFingerprint) })
        checks.push({ name: 'old-receipt-cannot-complete-new-candidate', passed: !!await rejected(() => runtime.coordinator.complete({ runId: run.id })) })
      } else {
        if (task.lifecycle === 'detach_reattach') checks.push({ name: 'real-subscriber-reconnect-preserves-running-turn', passed: firstEvents > 0 && secondEvents > 0 && await readFile(path.join(cwd, 'counter.txt'), 'utf8') === '1' && run.actions.filter(action => action.kind === 'tool.bash').length === 1 })
        if (task.lifecycle === 'pause_resume') {
          const paused = negativeControl ? await runtime.coordinator.inspect(run.id) : await runtime.coordinator.pause({ runId: run.id }); checks.push({ name: 'real-pause-state-persisted', passed: paused.state === 'paused' })
        }
        if (['coordinator_restart', 'protocol_pair_restart'].includes(task.lifecycle)) {
          if (task.lifecycle === 'protocol_pair_restart' && !negativeControl) {
            const saved = await runtime.kernel.sessions.getSession(run.binding.sessionId), index = saved.messages.findIndex(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use'))
            if (index < 0) throw new Error('No actual tool call available for protocol-pair recovery')
            await runtime.kernel.sessions.replaceMessages(run.binding.sessionId, saved.messages.slice(0, index + 1)); await runtime.kernel.run(flushNow)
            operations.push({ kind: 'truncate-after-persisted-tool-use', actionId: run.actions[0]?.id })
          }
          const id = run.id, previousSession = run.binding.sessionId
          if (!negativeControl) {
            await closeRuntime(runtime); runtime = null
            runtime = await createRecoveryRuntime({ task, cwd, privateRoot, profile, image, limits, ownerId: 'evaluation-reconstructed' })
            runtime.run = await runtime.coordinator.attach({ runId: id })
          }
          checks.push({ name: 'store-and-kernel-reopened-same-run', passed: runtime.run.ownerEpoch > beforeEpoch && runtime.run.binding.sessionId === previousSession })
        }
        if (['force_compaction', 'compaction_history_race', 'compaction_no_reduction', 'artifact_context_restore'].includes(task.lifecycle)) {
          const state = await compact(runtime, task, checks, operations, negativeControl)
          if (task.lifecycle === 'artifact_context_restore') {
            const beforeRefs = state.before.messages.flatMap(message => message.artifactRefs || []), afterRefs = state.after.messages.flatMap(message => message.artifactRefs || [])
            checks.push({ name: 'host-artifact-references-survive-compaction', passed: beforeRefs.length > 0 && beforeRefs.every(ref => afterRefs.some(next => next.id === ref.id && next.sha256 === ref.sha256)) })
          }
        }
        if (task.lifecycle !== 'compaction_no_reduction') {
          reference?.next()
          const result = await runtime.coordinator.resume({ runId: runtime.run.id, prompt: task.stages[1].prompt, mode: 'agent', signal }); turns.push(result.turn)
          if (task.lifecycle === 'protocol_pair_restart') {
            const saved = await runtime.kernel.sessions.getSession(runtime.run.binding.sessionId)
            checks.push({ name: 'actual-missing-response-recovered-from-artifact', passed: saved.messages.some(message => message.recoveredFromRun === runtime.run.id) && await pairs(runtime) })
            checks.push({ name: 'original-read-not-repeated', passed: result.run.actions.filter(action => action.kind === 'tool.read').length === 1 })
          }
          if (task.lifecycle === 'artifact_context_restore') {
            const saved = await runtime.kernel.sessions.getSession(runtime.run.binding.sessionId)
            const readIds = new Set(saved.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use' && block.name === 'artifact_read').map(block => block.id) : []))
            const foundTail = saved.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && readIds.has(block.tool_use_id) && String(block.content).includes('LAST=ARTIFACT-9001') && !block.is_error))
            checks.push({ name: 'actual-artifact-read-after-context-compression', passed: result.run.actions.some(action => action.kind === 'tool.artifact_read' && action.state === 'succeeded') && result.run.actions.filter(action => action.kind === 'tool.bash').length === 1 })
            checks.push({ name: 'archived-tail-independently-observed', passed: foundTail })
          }
        }
      }
    }
    const run = await runtime.store.getRun(runtime.run.id), budget = await runtime.store.getRunBudget({ runId: run.id }), events = await runtime.store.events({ runId: run.id })
    checks.push({ name: 'durable-identity-and-request-ledger-present', passed: run.id === runtime.run.id && budget.requests.some(request => request.kind === 'model') })
    const candidate = await captureAcceptanceCandidate(cwd), evidence = { durableRunId: run.id, ownerEpoch: String(run.ownerEpoch), beforeEventsHash,
      afterEventsHash: sha256(events), lifecycle: task.lifecycle, actions: run.actions, operations, budget,
      candidateHash: candidate.treeFingerprint, stateFingerprint: sha256({ profile: { ...profile, baseUrl: '<explicit-route>' }, image, mode }),
      lifecycleReceipt: sha256({ checks, runId: run.id, beforeEpoch, afterEpoch: run.ownerEpoch, events: sha256(events), candidate: candidate.treeFingerprint }),
      modelError: turns.some(turn => turn?.error && !['cancel_inflight', 'receipt_write_failure', 'abort_tool_batch', 'owner_epoch_takeover'].includes(task.lifecycle)),
      diagnostics, runState: run.state, mode, negativeControl, fixtureOnly: mode === 'system-selfcheck', externalAuthorizedUsd: reference ? 0 : budgetUsd,
      referenceRequests: reference?.requests() ?? null, oracleChecks: checks }
    proofs.set(evidence, { taskHash: sha256(task), hash: sha256(proofBody(evidence)), checks: structuredClone(checks) })
    return evidence
  } finally { release?.(); await closeRuntime(runtime); await reference?.close(); if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome }
}

/** Isolated child entry: parent independently verifies SQLite and filesystem
 * after SIGKILL; the IPC notice itself is never completion evidence. */
export async function runRecoveryCrashWorker(options) {
  let used = false
  const boundary = async (runtime, phase) => {
    if (options.negativeControl || used || phase !== (options.task.lifecycle === 'kill_after_prepare' ? 'before' : 'after')) return
    used = true
    process.send?.({ runId: runtime.run.id, boundary: options.task.lifecycle })
    await new Promise(() => {})
  }
  const runtime = await createRecoveryRuntime({ ...options, ownerId: 'evaluation-crash-worker', fault: { beforeTool: current => boundary(current, 'before'), afterTool: current => boundary(current, 'after') } })
  await start(runtime, options.task)
  await execute(runtime, options.task.prompt)
  if (options.negativeControl) {
    process.send?.({ runId: runtime.run.id, boundary: options.task.lifecycle, completedWithoutCrash: true })
    await closeRuntime(runtime)
    return
  }
  throw new Error('Crash worker never reached the selected tool boundary')
}
