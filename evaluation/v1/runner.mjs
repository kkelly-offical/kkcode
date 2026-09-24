import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { cases, createManifest, sha256, selectCases, summarizeResults } from './manifest.mjs'
import { evaluateCase, verifyReferenceDefinitions } from './oracles.mjs'
import { validateLiveProfile, runLiveTask, supportedRecovery } from './live-sdk.mjs'
import { runNegativeControls, runSourceProtectionControl } from './negative-controls.mjs'
import { createOfficeService } from '../../src/sdk/office.mjs'
import { createTaskWorkspace, taskWorkspaceBaseline } from '../../src/sdk/runs.mjs'
import { captureAcceptanceCandidate } from '../../src/kernel/session/acceptance-manifest.mjs'
import { userRootDir } from '../../src/storage/paths.mjs'
import { evaluationDiagnosticRoot, writeEvaluationDiagnostic, sanitizeDiagnostic } from './diagnostics.mjs'
import { runRecoveryScenario } from './recovery-drivers.mjs'

const exec = promisify(execFile)
let evaluationActive = false
const immutableImage = value => typeof value === 'string' && /^(sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(value)
async function writeFixture(root, files) {
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, value, { flag: 'wx', mode: 0o600 })
  }
}
async function initFixture(root) {
  const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' })
  // Only evaluator-owned fresh fixtures reach this function, before any model.
  for (const args of [['init', '-q'], ['add', '--all'], ['-c', 'user.name=KK Evaluation', '-c', 'user.email=evaluation@example.invalid', 'commit', '-qm', 'Frozen fixture']]) {
    await exec('git', ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false', ...args], { cwd: root, env, timeout: 30000 })
  }
}

async function officeOperations(cwd, operations, image, signal) {
  const service = await createOfficeService({ cwd, image }), evidence = []
  try { for (const request of operations) { const result = await service.run(request, { signal }); evidence.push({ operation: request.operation, hashes: (result.outputs || []).map(item => item.sha256), validation: result.validation }) } }
  finally { await service.dispose() }
  return { operations: operations.map(item => item.operation), receiptHash: sha256(evidence) }
}

/** Does not copy case definitions, probes, reference files or oracles into tasks.
 * The original fixture repo and private control plane remain outside the mount. */
export async function prepareTask(task, { parent, officeImage, signal }) {
  const root = await mkdtemp(path.join(parent, `${task.id}-`)), source = path.join(root, 'source')
  await mkdir(source, { mode: 0o700 })
  await writeFixture(source, task.fixtureFiles)
  if (task.setupOperations?.length) await officeOperations(source, task.setupOperations, officeImage, signal)
  await initFixture(source)
  const baseline = await taskWorkspaceBaseline(source)
  const workspace = await createTaskWorkspace({ cwd: source, expectedCommit: baseline.commit, parent: path.join(root, 'tasks') })
  const snapshot = await captureAcceptanceCandidate(workspace.cwd, { includeFiles: true })
  const mutable = new Set(task.driver === 'repository-function' ? Object.keys(task.referenceFiles) : [])
  const baselineHashes = Object.fromEntries(snapshot.files.filter(file => !mutable.has(file.path)).map(file => [file.path, file.hash]))
  return { root, cwd: workspace.cwd, baseRevision: baseline.commit, fixtureCandidateHash: snapshot.treeFingerprint, baselineHashes }
}

function baseResult(task, context, repetition) {
  const manifestTask = context.manifest.tasks.find(item => item.id === task.id)
  return { schema: 'kk.evaluation.result.v1', suiteRunId: context.runId, caseId: task.id, category: task.category, split: task.split,
    critical: task.critical, mode: context.mode, repetition, manifestHash: context.manifest.manifestHash, taskHash: manifestTask.taskHash,
    candidateHash: context.candidateHash, configHash: context.configHash, model: context.profile?.model || null,
    startedAt: new Date().toISOString(), status: 'not_run', safetyPassed: false, evidence: {} }
}

export async function runEvaluation(options = {}) {
  if (evaluationActive) throw new Error('Evaluation suites require separate processes for concurrency; private state must not overlap')
  evaluationActive = true
  try { return await executeEvaluation(options) } finally { evaluationActive = false }
}

async function executeEvaluation({ mode = 'selfcheck', ids = [], split = 'development', repetitions = 1,
  image, officeImage, outputDirectory, profile = null, candidateHash = null, budgetUsd = 0, deadlineAt = null,
  candidateDirectory = process.cwd(), keepWorkspaces = false, signal, onResult } = {}) {
  if (!['selfcheck', 'live'].includes(mode)) throw new Error('Unknown evaluation mode')
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('Invalid repetition count')
  if (!immutableImage(image)) throw new Error('An already-installed immutable node execution image is required')
  const manifest = createManifest(), selected = selectCases({ ids, split })
  const diagnosticRoot = evaluationDiagnosticRoot()
  if (!selected.length) throw new Error('No evaluation cases selected')
  if (selected.some(task => task.driver === 'office-document') && !immutableImage(officeImage)) throw new Error('Document tasks require an approved immutable Office image')
  const runtimeCandidate = (await captureAcceptanceCandidate(candidateDirectory)).treeFingerprint
  if (mode === 'live') {
    if (candidateHash !== runtimeCandidate) throw new Error('Live candidate hash does not match the frozen runtime source')
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw new Error('Live mode requires explicit positive total USD budget and absolute deadline')
    profile = validateLiveProfile(profile)
  } else if (budgetUsd !== 0 || profile !== null) throw new Error('Selfcheck never accepts a paid budget or provider profile')
  const context = { mode, manifest, candidateHash: runtimeCandidate, profile, runId: `evaluation_${randomUUID()}`,
    configHash: sha256({ profile, image, officeImage: officeImage || null, mode, budgetUsd, deadlineAt, repetitions, selectedCases: selected.map(task => task.id) }) }
  const output = path.resolve(outputDirectory || path.join('test-results', 'evaluation', context.runId))
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
  await mkdir(output, { mode: 0o700 }) // Never overwrite prior evidence.
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
  const privateParent = mode === 'live' ? path.join(userRootDir(), 'evaluation-runs') : os.tmpdir()
  if (mode === 'live') await mkdir(privateParent, { recursive: true, mode: 0o700 })
  const workspaceParent = await mkdtemp(path.join(privateParent, 'kk-evaluation-'))
  const parentIdentity = await lstat(workspaceParent), previousHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = path.join(workspaceParent, 'private-state')
  const results = []
  const diagnosticSecrets = mode === 'live' && profile.apiKeyEnv ? [process.env[profile.apiKeyEnv]] : []
  // Fixed allocation is conservative: aggregate authorized spend cannot exceed
  // the operator's suite budget, even when some tasks terminate early.
  const perTaskBudget = mode === 'live' ? budgetUsd / (selected.length * repetitions) : 0
  try {
    for (let repetition = 1; repetition <= repetitions; repetition++) for (const task of selected) {
      signal?.throwIfAborted()
      const result = baseResult(task, context, repetition)
      try {
        if (task.driver === 'durable-recovery' && !supportedRecovery.has(task.lifecycle)) {
          result.status = 'unsupported'; result.reason = 'Actual lifecycle fault driver is not implemented for this execution mode; no fabricated reference completion'
        } else {
          if (mode === 'live' && (await captureAcceptanceCandidate(candidateDirectory)).treeFingerprint !== runtimeCandidate) throw Object.assign(new Error('Runtime candidate changed during evaluation'), { code: 'EVALUATION_CANDIDATE_CHANGED' })
          verifyReferenceDefinitions(task)
          const fixture = await prepareTask(task, { parent: workspaceParent, officeImage, signal })
          if (keepWorkspaces) result.retainedWorkspace = fixture.cwd
          let execution
          if (mode === 'selfcheck') {
            if (task.driver === 'durable-recovery') execution = await runRecoveryScenario({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'),
              image, mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 180000, signal })
            else if (task.referenceOperations) execution = await officeOperations(fixture.cwd, task.referenceOperations, officeImage, signal)
            else { for (const [name, value] of Object.entries(task.referenceFiles)) await writeFile(path.join(fixture.cwd, name), value); execution = { operations: ['trusted-reference-patch'] } }
          } else execution = await runLiveTask({ task, cwd: fixture.cwd, privateRoot: path.join(fixture.root, 'control'), profile, image, officeImage,
            budgetUsd: perTaskBudget, deadlineAt, signal })
          if (execution.unsupported) { result.status = 'unsupported'; result.reason = execution.reason }
          else {
            const candidate = await captureAcceptanceCandidate(fixture.cwd)
            if (task.driver === 'durable-recovery') {
              if (execution.candidateHash !== candidate.treeFingerprint) throw new Error('Recovery candidate changed after host receipt')
              if (mode === 'live' && execution.fixtureOnly) throw new Error('Reference provider evidence cannot be counted as a live model result')
            } else execution.candidateHash = candidate.treeFingerprint
            const oracle = await evaluateCase({ task, cwd: fixture.cwd, image, officeImage, baselineHashes: fixture.baselineHashes, execution, signal })
            if ((await captureAcceptanceCandidate(fixture.cwd)).treeFingerprint !== candidate.treeFingerprint) throw Object.assign(new Error('Oracle changed the candidate'), { code: 'EVALUATION_ORACLE_MUTATED' })
            result.status = oracle.passed && !execution.modelError ? 'passed' : 'failed'; result.safetyPassed = oracle.safetyPassed
            result.evidence = { independentOracle: true, oracleReceipt: oracle.receiptHash, candidateTree: candidate.treeFingerprint,
              fixtureCandidate: fixture.fixtureCandidateHash, baselineRevision: fixture.baseRevision, durableRunId: execution.durableRunId || null,
              lifecycleReceipt: execution.lifecycleReceipt || null, actionsHash: sha256(execution.actions || []), stateFingerprint: execution.stateFingerprint || null }
            result.checks = oracle.checks; result.budget = execution.budget || { authorizedUsd: 0, inferenceRequests: 0 }
            if (execution.modelError || !oracle.passed) {
              const error = new Error(execution.modelError ? (execution.diagnostics || ['Model execution did not complete']).join('\n')
                : `Independent oracle rejected: ${oracle.checks.filter(check => !check.passed).map(check => check.name).join(', ')}`)
              result.diagnosticId = await writeEvaluationDiagnostic({ root: diagnosticRoot, error, taskId: task.id, secrets: diagnosticSecrets })
            }
            if (mode === 'selfcheck') {
              let negatives
              if (task.driver === 'durable-recovery') {
                const wrong = await prepareTask(task, { parent: workspaceParent, officeImage, signal })
                const badExecution = await runRecoveryScenario({ task, cwd: wrong.cwd, privateRoot: path.join(wrong.root, 'control'), image,
                  mode: 'system-selfcheck', budgetUsd: 0, deadlineAt: Date.now() + 180000, signal, negativeControl: true })
                const rejected = await evaluateCase({ task, cwd: wrong.cwd, image, baselineHashes: wrong.baselineHashes, execution: badExecution, signal })
                if (rejected.checks.find(check => check.name === 'protected-inputs-preserved')?.passed !== true) throw new Error('Recovery semantic negative changed original input instead of testing its lifecycle')
                negatives = { semanticNegativeRejected: rejected.passed === false, semanticNegativeChecks: rejected.checks.filter(check => !check.passed).map(check => check.name),
                  ...await runSourceProtectionControl({ task, cwd: fixture.cwd, image, baselineHashes: fixture.baselineHashes, execution, signal }) }
              } else negatives = await runNegativeControls({ task, cwd: fixture.cwd, image, officeImage, baselineHashes: fixture.baselineHashes, execution, signal })
              Object.assign(result, negatives)
              result.negativeControlRejected = negatives.semanticNegativeRejected && negatives.sourceProtectionRejected
              if (!result.negativeControlRejected && result.status === 'passed') result.status = 'failed'
            }
            if (mode === 'live' && (await captureAcceptanceCandidate(candidateDirectory)).treeFingerprint !== runtimeCandidate) {
              throw Object.assign(new Error('Runtime candidate changed before result sealing'), { code: 'EVALUATION_CANDIDATE_CHANGED' })
            }
          }
          if (keepWorkspaces) result.retainedWorkspace = fixture.cwd
        }
      } catch (error) {
        result.status = 'error'; result.errorCode = /^[A-Z_a-z0-9.-]{1,80}$/.test(error.code || '') ? error.code : 'EVALUATION_EXECUTION_ERROR'
        result.reason = 'Task or independent oracle did not finish; inspect the private diagnostic ID, not a successful model result'
        try { result.diagnosticId = await writeEvaluationDiagnostic({ root: diagnosticRoot, error, taskId: task.id, secrets: diagnosticSecrets }) }
        catch { result.reason = 'Task failed and the private diagnostic could not be saved; check private state directory permissions and free space' }
        if (mode === 'selfcheck') result.diagnostic = sanitizeDiagnostic(error.message, diagnosticSecrets, 500)
      }
      result.endedAt = new Date().toISOString()
      await writeFile(path.join(output, `${task.id}-${repetition}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
      results.push(result); await onResult?.(result)
    }
    const summary = summarizeResults(results, manifest)
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 })
    return { output, summary, results, ...(mode === 'live' ? { privateEvidenceRoot: workspaceParent } : {}) }
  } finally {
    if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome
    const current = await lstat(workspaceParent).catch(() => null)
    if (mode !== 'live' && !keepWorkspaces && current?.isDirectory() && !current.isSymbolicLink() && current.dev === parentIdentity.dev && current.ino === parentIdentity.ino) await rm(workspaceParent, { recursive: true, force: false })
  }
}

export async function readResultFiles(directory) {
  const { readdir } = await import('node:fs/promises')
  const names = (await readdir(directory)).filter(name => /^[RCDS]\d\d-\d+\.json$/.test(name)).sort()
  return Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8').then(JSON.parse)))
}

export { cases }
