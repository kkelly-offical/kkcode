import path from 'node:path'
import { constants } from 'node:fs'
import { mkdir, lstat, realpath, open, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { projectEvaluationChecks } from './result-projection.mjs'

const fail = () => { throw new Error('Evaluation result publication refused: private evidence or public projection is invalid') }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) }
const overlap = (a, b) => within(a, b) || within(b, a)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const statuses = new Set(['not_run', 'passed', 'failed', 'unsupported', 'error'])
const privateNote = '密封评测的详细检查与诊断仅保存在宿主私密记录中。'

function budgetSummary(budget) {
  if (!budget || typeof budget !== 'object') return undefined
  const result = {}
  for (const key of ['budgetUsd', 'deadlineAt', 'spentUsd', 'reservedUsd', 'unknownUsd', 'reservedTokens', 'usedRequests', 'authorizedUsd', 'inferenceRequests']) {
    if (number(budget[key])) result[key] = budget[key]
  }
  if (Array.isArray(budget.requests)) {
    if (budget.requests.length > 10000) fail()
    result.requests = budget.requests.map(request => {
      const row = {}
      if (['model', 'delegation'].includes(request.kind)) row.kind = request.kind
      if (['reserved', 'settled', 'unknown'].includes(request.status)) row.status = request.status
      for (const key of ['tokenAllowance', 'reservedUsd', 'amountUsd', 'ownerEpoch', 'createdAt', 'settledAt']) if (number(request[key])) row[key] = request[key]
      if (request.amountUsd === null) row.amountUsd = null
      return row
    })
  }
  // Full route profiles and service details stay in the private receipt. Public
  // comparisons can still identify fixed scopes without arbitrary model strings.
  if (Array.isArray(budget.profiles)) result.scopeHashes = [...new Set(budget.profiles.map(profile => profile.scopeHash).filter(hash))]
  return result
}

function projectRow(base, raw, checks, privateResultId) {
  if (!statuses.has(raw.status) || typeof raw.safetyPassed !== 'boolean') fail()
  const row = {}
  for (const key of ['schema', 'suiteRunId', 'caseId', 'category', 'split', 'critical', 'mode', 'repetition', 'manifestHash', 'taskHash',
    'graderRevision', 'candidateHash', 'configHash', 'model', 'startedAt']) if (Object.hasOwn(base, key)) row[key] = base[key]
  row.status = raw.status; row.safetyPassed = raw.safetyPassed
  if (typeof raw.endedAt !== 'string' || !Number.isFinite(Date.parse(raw.endedAt)) || new Date(raw.endedAt).toISOString() !== raw.endedAt) fail()
  row.endedAt = raw.endedAt
  row.checks = checks
  row.evidence = {}
  if (typeof raw.evidence?.independentOracle === 'boolean') row.evidence.independentOracle = raw.evidence.independentOracle
  for (const key of ['oracleReceipt', 'candidateTree', 'fixtureCandidate', 'lifecycleReceipt', 'actionsHash', 'stateFingerprint']) {
    if (hash(raw.evidence?.[key]) || raw.evidence?.[key] === null) row.evidence[key] = raw.evidence[key]
  }
  if (/^[a-f0-9]{40,64}$/.test(raw.evidence?.baselineRevision || '')) row.evidence.baselineRevision = raw.evidence.baselineRevision
  if (raw.evidence?.durableRunId === null || typeof raw.evidence?.durableRunId === 'string' && raw.evidence.durableRunId.startsWith('run_') && uuid(raw.evidence.durableRunId.slice(4))) row.evidence.durableRunId = raw.evidence.durableRunId
  for (const key of ['semanticNegativeRejected', 'sourceProtectionRejected', 'negativeControlRejected']) {
    if (typeof raw[key] === 'boolean') row[key] = raw[key]
  }
  for (const key of ['semanticNegativeChecks', 'sourceProtectionChecks']) if (Array.isArray(raw[key])) {
    row[key] = projectEvaluationChecks({ split: 'sealed', category: base.category,
      checks: raw[key].map(() => ({ name: 'private-negative-check', passed: false })) }).publicChecks
  }
  if (raw.budget) row.budget = budgetSummary(raw.budget)
  if (raw.reason !== undefined || raw.diagnostic !== undefined || raw.errorCode !== undefined) row.reason = privateNote
  if (raw.errorCode !== undefined) row.errorCode = 'EVALUATION_SEALED_ERROR'
  if (typeof raw.diagnosticId === 'string' && raw.diagnosticId.startsWith('diag_') && uuid(raw.diagnosticId.slice(5))) row.diagnosticId = raw.diagnosticId
  row.privateResultId = privateResultId
  return freeze(row)
}

async function privateRoot(directory, output, workspaceRoots) {
  if (typeof directory !== 'string' || !directory) fail()
  const requested = path.resolve(directory), publicRoot = await realpath(output)
  const forbidden = [publicRoot, ...await Promise.all(workspaceRoots.map(root => realpath(root)))]
  if (forbidden.some(root => overlap(root, requested))) fail()
  // Resolve an existing ancestor before making anything. System aliases (for
  // example macOS /var -> /private/var) otherwise evade the lexical comparison
  // and create a private directory inside public/model space before rejection.
  let ancestor = requested
  const missing = []
  for (;;) {
    let info
    try { info = await lstat(ancestor) } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor)
      continue
    }
    if (ancestor === requested && info.isSymbolicLink()) fail()
    break
  }
  const parent = await realpath(ancestor)
  if (!(await lstat(parent)).isDirectory()) fail()
  const planned = path.join(parent, ...missing)
  if (forbidden.some(root => overlap(root, planned))) fail()
  // Use the resolved path rather than following the supplied ancestor alias a
  // second time. Keep the post-create check: no evidence may be written through
  // a substituted directory or into a newly overlapping location.
  await mkdir(planned, { recursive: true, mode: 0o700 })
  const stat = await lstat(planned), canonical = await realpath(planned)
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== planned || forbidden.some(root => overlap(root, canonical))
    || process.platform !== 'win32' && (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) fail()
  return canonical
}

/** Actual runner publication boundary. v1-v3/development retain their existing
 * representation. A sealed v4 result is detached before any filesystem await,
 * persisted privately first, then the same safe row reaches disk/list/callback. */
export async function publishEvaluationResult({ suiteVersion, base, result, outputDirectory, privateDirectory, workspaceRoots = [], results, onResult }) {
  const identity = { caseId: base.caseId, repetition: base.repetition }
  if (!/^[RCDS][0-9]{2}$/.test(identity.caseId || '') || !Number.isSafeInteger(identity.repetition) || identity.repetition < 1 || identity.repetition > 20) fail()
  workspaceRoots = [...workspaceRoots]
  const sealed = suiteVersion === 'v4' && base.split === 'sealed'
  let published = result
  if (sealed) {
    let raw, header, projection
    try {
      raw = structuredClone(result); header = structuredClone(base)
      projection = projectEvaluationChecks({ split: header.split, category: header.category, checks: raw.checks || [] })
    } catch { fail() }
    const id = `sealed_result_${randomUUID()}`
    published = projectRow(header, raw, projection.publicChecks, id)
    const content = JSON.stringify({ schema: 'kk.evaluation.private-result.v1', id, createdAt: new Date().toISOString(),
      result: raw, checks: projection.privateChecks }, null, 2)
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) fail()
    const root = await privateRoot(privateDirectory, outputDirectory, workspaceRoots)
    const file = await open(path.join(root, `${id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
  }
  // Header values originate in the frozen catalog/run, not dynamic oracle text.
  await writeFile(path.join(outputDirectory, `${identity.caseId}-${identity.repetition}.json`), JSON.stringify(published, null, 2), { flag: 'wx', mode: 0o600 })
  results.push(published)
  await onResult?.(published)
  return published
}
