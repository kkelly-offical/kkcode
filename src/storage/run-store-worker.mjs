import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, realpathSync, readdirSync, statfsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  RUN_STORE_SCHEMA_VERSION, RUN_STATES, object, text, id, integer, oneOf, strings, hash,
  validateTaskContract, validateAction, validateVerification, validateRunBinding, runStoreError
} from './run-store-contracts.mjs'
import { normalizeTaskGraph, assertTaskGraphTransition, taskGraphComplete } from './run-graph-contracts.mjs'
import { createRunStoreBackup, listRunStoreBackups, verifyRunStoreBackup, restoreRunStoreBackup } from './run-store-backup.mjs'
import { acquireProcessLock } from './process-lock.mjs'
import { normalizeBudgetProfile } from './run-budget-profile.mjs'
import { normalizeLocalFreePolicy } from './local-free-policy.mjs'
import { redactedStorageFailure } from './run-store-errors.mjs'

const APPLICATION_ID = 0x4b4b5255
const GUARD_KEYS = ['runId', 'expectedRevision', 'ownerId', 'ownerEpoch']
const readOnly = process.argv[3] === 'read-only'
let database
let databaseFile

function secureEntry(file, directory = false) {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)) throw runStoreError('UNSAFE_STORE_PATH', 'Storage paths must be private ordinary files and directories, not links')
  if (process.getuid && stat.uid !== process.getuid()) throw runStoreError('UNSAFE_STORE_PATH', 'Storage must be owned by the current user')
  if (!readOnly) chmodSync(file, directory ? 0o700 : 0o600)
  else if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw runStoreError('UNSAFE_STORE_PATH', 'Read-only inspection requires already-private storage permissions')
}

async function initialize(directory) {
  process.umask(0o077)
  if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const allowedEntries = new Set(['runs.sqlite', 'runs.sqlite-wal', 'runs.sqlite-shm', 'runs.sqlite-journal', 'backups'])
  const resolved = realpathSync(directory)
  if ([path.parse(resolved).root, realpathSync(os.tmpdir()), realpathSync(os.homedir())].includes(resolved) || readdirSync(directory).some(entry => !allowedEntries.has(entry))) throw runStoreError('UNSAFE_STORE_PATH', 'Use a dedicated run storage directory without unrelated files')
  if (process.platform === 'linux' && [0x6969, 0x517b, 0xff534d42, 0x5346414f].includes(statfsSync(resolved).type)) throw runStoreError('UNSAFE_STORE_PATH', 'Durable run storage requires a local filesystem, not a network share')
  if (process.platform === 'win32' && resolved.startsWith('\\\\')) throw runStoreError('UNSAFE_STORE_PATH', 'Durable run storage requires a local filesystem, not a network share')
  secureEntry(directory, true)
  let lease
  if (!readOnly) {
    const deadline = Date.now() + 10_000
    for (;;) {
      try { lease = await acquireProcessLock(`${resolved}.initialize.lock`); break }
      catch (error) { if (error.code !== 'device_in_use' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)) }
    }
  }
  try { initializeDatabase(resolved) } finally { await lease?.release() }
}

function initializeDatabase(resolved) {
  const file = path.join(resolved, 'runs.sqlite')
  databaseFile = file
  let created = false
  if (!readOnly) {
    try { const fd = openSync(file, 'wx', 0o600); closeSync(fd); created = true } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  secureEntry(file)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { secureEntry(file + suffix) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  database = new DatabaseSync(file, { readOnly })
  database.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;')
  const { appId, version, tables } = transaction(() => ({
    appId: database.prepare('PRAGMA application_id').get().application_id,
    version: database.prepare('PRAGMA user_version').get().user_version,
    tables: database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  }), true)
  if (version > RUN_STORE_SCHEMA_VERSION) throw runStoreError('FUTURE_SCHEMA', 'Run storage was written by a newer version; refuse to downgrade it')
  if (!created && appId === 0 && version === 0 && !tables.length) throw runStoreError('INVALID_STORE', 'An existing empty or truncated database is not a new run store; inspect or restore it instead of resetting history')
  if (appId !== APPLICATION_ID && (appId !== 0 || tables.length || version !== 0)) throw runStoreError('INVALID_STORE', 'Database is not a recognized KK Code run store')
  if (tables.length && ![1, RUN_STORE_SCHEMA_VERSION].includes(version)) throw runStoreError('INVALID_STORE', 'Run storage migration metadata is inconsistent')
  if (readOnly && version !== RUN_STORE_SCHEMA_VERSION) throw runStoreError('MIGRATION_REQUIRED', 'Read-only inspection cannot upgrade this run store; open it with the current trusted local runtime first')
  if (!readOnly) database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
  transaction(() => {
    // Another first-open worker may have completed initialization while we waited for the lock.
    let lockedVersion = database.prepare('PRAGMA user_version').get().user_version
    let fresh = false
    if (lockedVersion === 0 && !readOnly) {
      database.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, state TEXT NOT NULL, revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
          owner_epoch INTEGER NOT NULL, contract_version INTEGER NOT NULL, contract_json TEXT NOT NULL,
          candidate_hash TEXT, candidate_generation INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE contracts (
          run_id TEXT NOT NULL REFERENCES runs(id), version INTEGER NOT NULL, contract_json TEXT NOT NULL,
          approval_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(run_id, version)
        );
        CREATE TABLE actions (
          run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, spec_json TEXT NOT NULL,
          state TEXT NOT NULL, owner_epoch INTEGER NOT NULL, receipt_json TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(run_id, id)
        );
        CREATE TABLE verifications (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
          id TEXT NOT NULL, criterion_id TEXT NOT NULL, candidate_hash TEXT NOT NULL,
          candidate_generation INTEGER NOT NULL, contract_version INTEGER NOT NULL,
          status TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(run_id, id)
        );
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
          revision INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(run_id, revision)
        );
        CREATE INDEX actions_unresolved ON actions(run_id, state);
        CREATE INDEX verification_current ON verifications(run_id, criterion_id, sequence);
        CREATE INDEX events_by_run ON events(run_id, sequence);
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
      `)
      database.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(1, Date.now())
      fresh = true; lockedVersion = 1
    }
    if (lockedVersion === 1 && !readOnly) {
      const prior = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      if (prior.length !== 1 || prior[0].version !== 1) throw runStoreError('INVALID_STORE', 'Legacy run migration metadata is inconsistent')
      if (database.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok') || database.prepare('PRAGMA foreign_key_check').all().length) throw runStoreError('CORRUPT_STORE', 'Legacy run storage is corrupt; migration did not replace it')
      const backup = fresh ? null : createRunStoreBackup(file)
      database.exec(`
        ALTER TABLE runs ADD COLUMN write_protocol INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN write_epoch INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE schema_migrations ADD COLUMN backup_id TEXT;
        ALTER TABLE schema_migrations ADD COLUMN backup_sha256 TEXT;
        CREATE TRIGGER runs_protocol_insert BEFORE INSERT ON runs
          WHEN NEW.write_protocol <> 2 BEGIN SELECT RAISE(ABORT, 'run_store_runtime_upgrade_required'); END;
        CREATE TRIGGER runs_protocol_update BEFORE UPDATE ON runs
          WHEN NEW.write_protocol <> 2 OR NEW.write_epoch <> OLD.write_epoch + 1
          BEGIN SELECT RAISE(ABORT, 'run_store_runtime_upgrade_required'); END;
        PRAGMA user_version = 2;
      `)
      database.prepare('INSERT INTO schema_migrations (version, applied_at, backup_id, backup_sha256) VALUES (2, ?, ?, ?)').run(Date.now(), backup?.id ?? null, backup?.sha256 ?? null)
    }
    const migrations = database.prepare('SELECT version, backup_id, backup_sha256 FROM schema_migrations ORDER BY version').all()
    if (migrations.length !== 2 || migrations.some((migration, index) => migration.version !== index + 1) || migrations.some(migration => Boolean(migration.backup_id) !== Boolean(migration.backup_sha256) || migration.backup_sha256 && !/^[a-f0-9]{64}$/.test(migration.backup_sha256))) throw runStoreError('INVALID_STORE', 'Run storage migration history is inconsistent')
    if (database.prepare('PRAGMA user_version').get().user_version !== RUN_STORE_SCHEMA_VERSION) throw runStoreError('FUTURE_SCHEMA', 'Run storage schema changed while opening it')
  }, readOnly)
  if (database.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok') || database.prepare('PRAGMA foreign_key_check').all().length) throw runStoreError('CORRUPT_STORE', 'Run storage integrity check failed; restore a verified backup')
  secureEntry(file)
}

function transaction(operation, read = false) {
  database.exec(read ? 'BEGIN' : 'BEGIN IMMEDIATE')
  try { const result = operation(); database.exec('COMMIT'); return result } catch (error) { database.exec('ROLLBACK'); throw error }
}

function row(runId) {
  id(runId, 'runId')
  const result = database.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!result) throw runStoreError('RUN_NOT_FOUND', 'Durable run was not found')
  return result
}

function runRecord(runId) {
  const value = row(runId)
  const created = database.prepare("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.created' ORDER BY sequence LIMIT 1").get(runId)
  const turn = database.prepare("SELECT data_json FROM events WHERE run_id = ? AND type IN ('turn.started','turn.ended','turn.interrupted') ORDER BY sequence DESC LIMIT 1").get(runId)
  return {
    id: value.id, state: value.state, revision: value.revision, ownerId: value.owner_id,
    ownerEpoch: value.owner_epoch, contractVersion: value.contract_version,
    contract: JSON.parse(value.contract_json), candidateHash: value.candidate_hash,
    candidateGeneration: value.candidate_generation, createdAt: value.created_at, updatedAt: value.updated_at,
    binding: created ? JSON.parse(created.data_json).binding ?? null : null,
    lastTurn: turn ? JSON.parse(turn.data_json) : null,
    budget: runBudget(runId),
    actions: database.prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at, id').all(runId).map(action => ({
      ...JSON.parse(action.spec_json), state: action.state, ownerEpoch: action.owner_epoch,
      receipt: action.receipt_json ? JSON.parse(action.receipt_json) : null,
      createdAt: action.created_at, updatedAt: action.updated_at
    })),
    verifications: database.prepare('SELECT * FROM verifications WHERE run_id = ? ORDER BY sequence').all(runId).map(receipt => ({
      id: receipt.id, criterionId: receipt.criterion_id, candidateHash: receipt.candidate_hash,
      candidateGeneration: receipt.candidate_generation, contractVersion: receipt.contract_version,
      status: receipt.status, evidenceRefs: JSON.parse(receipt.evidence_json), createdAt: receipt.created_at
    }))
  }
}

function guard(input, { terminal = false } = {}) {
  const value = row(input.runId)
  integer(input.expectedRevision, 'expectedRevision', 1)
  integer(input.ownerEpoch, 'ownerEpoch', 1)
  id(input.ownerId, 'ownerId')
  if (value.owner_id !== input.ownerId || value.owner_epoch !== input.ownerEpoch) throw runStoreError('STALE_OWNER', 'Run ownership changed; this writer may no longer commit')
  if (value.revision !== input.expectedRevision) throw runStoreError('REVISION_CONFLICT', 'Run changed; reload it before issuing another mutation')
  if (!terminal && ['completed', 'cancelled'].includes(value.state)) throw runStoreError('TERMINAL_RUN', 'Terminal runs cannot start new work')
  return value
}

function event(runId, type, data = {}) {
  const at = Date.now()
  database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, revision = revision + 1, updated_at = ? WHERE id = ?').run(at, runId)
  const revision = row(runId).revision
  database.prepare('INSERT INTO events (run_id, revision, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)').run(runId, revision, type, JSON.stringify(data), at)
}

function approval(value) {
  object(value, ['approved', 'actorId', 'reason'], 'approval')
  if (value.approved !== true) throw runStoreError('APPROVAL_REQUIRED', 'An explicit host-confirmed approval is required')
  return { approved: true, actorId: id(value.actorId, 'approval.actorId'), reason: text(value.reason, 'approval.reason') }
}

function unresolved(runId) {
  return database.prepare("SELECT id FROM actions WHERE run_id = ? AND state IN ('prepared', 'unknown')").all(runId)
}

function taskGraph(runId, graphId) {
  const found = database.prepare("SELECT data_json FROM events WHERE run_id = ? AND type = 'graph.updated' AND json_extract(data_json, '$.graph.id') = ? ORDER BY sequence DESC LIMIT 1").get(runId, graphId)
  return found ? normalizeTaskGraph(JSON.parse(found.data_json).graph) : null
}

function taskGraphs(runId) {
  return database.prepare("SELECT data_json FROM (SELECT data_json, ROW_NUMBER() OVER (PARTITION BY json_extract(data_json, '$.graph.id') ORDER BY sequence DESC) AS ordinal FROM events WHERE run_id = ? AND type = 'graph.updated') WHERE ordinal = 1").all(runId).map(row => normalizeTaskGraph(JSON.parse(row.data_json).graph))
}

function budgetAmount(value, label = 'amountUsd') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw runStoreError('INVALID_INPUT', `${label} must be a finite USD amount between zero and one million`)
  return value
}

function localFreeBudget(policy, budgetUsd, profiles) {
  if (policy === undefined) return undefined
  const normalized = normalizeLocalFreePolicy(policy)
  if (budgetUsd !== 0 || profiles.length !== 1 || ['provider', 'model', 'protocol', 'scopeHash'].some(key => profiles[0][key] !== normalized[key]) || Object.values(profiles[0].rates).some(rate => rate !== 0)) {
    throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'Local free inference requires zero USD and exactly one matching zero-rate pricing scope')
  }
  return normalized
}

function runBudget(runId) {
  const config = database.prepare("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.configured' ORDER BY sequence DESC LIMIT 1").get(runId)
  if (!config) return null
  const { budgetUsd, deadlineAt, profiles: initialProfiles = [], localFreePolicy: configuredFreePolicy } = JSON.parse(config.data_json)
  const profiles = [...initialProfiles, ...database.prepare("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.profile_approved' ORDER BY sequence").all(runId).map(row => JSON.parse(row.data_json).profile)].map(normalizeBudgetProfile)
  const localFreePolicy = localFreeBudget(configuredFreePolicy, budgetUsd, profiles)
  const requests = database.prepare("SELECT data_json FROM (SELECT data_json, sequence, ROW_NUMBER() OVER (PARTITION BY json_extract(data_json, '$.request.requestId') ORDER BY sequence DESC) AS ordinal FROM events WHERE run_id = ? AND type IN ('budget.reserved', 'budget.settled', 'budget.unknown', 'budget.reconciled')) WHERE ordinal = 1 ORDER BY sequence").all(runId).map(row => JSON.parse(row.data_json).request)
  let spentUsd = 0, reservedUsd = 0, unknownUsd = 0
  for (const request of requests) {
    if (request.status === 'settled') spentUsd += request.amountUsd
    else if (request.status === 'reserved') reservedUsd += request.reservedUsd
    else unknownUsd += request.reservedUsd
  }
  return { budgetUsd, deadlineAt, spentUsd, reservedUsd, unknownUsd, requests, profiles,
    ...(localFreePolicy ? { localFreePolicy, usedRequests: requests.length, reservedTokens: requests.reduce((sum, request) => sum + integer(request.tokenAllowance, 'request.tokenAllowance', 1, localFreePolicy.maxTokens), 0) } : {}) }
}

function ensureComplete(value) {
  if (runRecord(value.id).lastTurn?.status === 'running') throw runStoreError('TURN_ACTIVE', 'An executing turn must settle before completing the task')
  if (unresolved(value.id).length) throw runStoreError('UNRESOLVED_ACTIONS', 'Reconcile every pending or unknown action before completing the task')
  if (taskGraphs(value.id).some(graph => !taskGraphComplete(graph))) throw runStoreError('UNRESOLVED_TASK_GRAPH', 'Every delegated task graph must be accepted or safely cancelled before completing the parent')
  if (runBudget(value.id)?.requests.some(request => request.status !== 'settled')) throw runStoreError('BUDGET_OUTCOME_UNKNOWN', 'Every model or delegated budget reservation requires a confirmed result before completion')
  const contract = JSON.parse(value.contract_json)
  if (!value.candidate_hash || !contract.requiredCriteria.length) throw runStoreError('VERIFICATION_REQUIRED', 'Completion requires a candidate and at least one explicit required criterion')
  for (const criterion of contract.requiredCriteria) {
    const receipt = database.prepare('SELECT status, evidence_json FROM verifications WHERE run_id = ? AND criterion_id = ? AND candidate_hash = ? AND candidate_generation = ? AND contract_version = ? ORDER BY sequence DESC LIMIT 1').get(value.id, criterion.id, value.candidate_hash, value.candidate_generation, value.contract_version)
    if (receipt?.status !== 'passed' || JSON.parse(receipt.evidence_json).length === 0) throw runStoreError('VERIFICATION_REQUIRED', `Required criterion ${criterion.id} has no current passing evidence`)
  }
}

const methods = {
  getRunBudget(input) {
    object(input, ['runId'], 'getRunBudget'); row(input.runId)
    return transaction(() => runBudget(input.runId), true)
  },
  configureRunBudget(input) {
    object(input, [...GUARD_KEYS, 'budgetUsd', 'deadlineAt', 'approval', 'profiles', 'localFreePolicy'], 'configureRunBudget')
    budgetAmount(input.budgetUsd, 'budgetUsd'); integer(input.deadlineAt, 'deadlineAt', 1)
    const authorized = approval(input.approval)
    if (!Array.isArray(input.profiles ?? []) || (input.profiles ?? []).length > 32) throw runStoreError('INVALID_BUDGET_PROFILE', 'A task budget accepts at most 32 immutable pricing profiles')
    const profiles = (input.profiles ?? []).map(normalizeBudgetProfile)
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length || new Set(profiles.map(profile => profile.scopeHash)).size !== profiles.length) throw runStoreError('INVALID_BUDGET_PROFILE', 'A pricing scope must have exactly one immutable profile')
    const localFreePolicy = localFreeBudget(input.localFreePolicy, input.budgetUsd, profiles)
    return transaction(() => {
      const run = guard(input), previous = runBudget(run.id)
      if (previous) {
        if (previous.budgetUsd !== input.budgetUsd || previous.deadlineAt !== input.deadlineAt || previous.localFreePolicy?.id !== localFreePolicy?.id || JSON.stringify(previous.profiles.map(profile => profile.id).sort()) !== JSON.stringify(profiles.map(profile => profile.id).sort())) throw runStoreError('BUDGET_IMMUTABLE', 'Approved budget, deadline, local free policy and price profiles are frozen; resume cannot replace the basis')
        return previous
      }
      if (input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 7 * 24 * 60 * 60 * 1000) throw runStoreError('INVALID_INPUT', 'The initial task deadline must be within the next seven days')
      event(run.id, 'budget.configured', { budgetUsd: input.budgetUsd, deadlineAt: input.deadlineAt, profiles, ...(localFreePolicy ? { localFreePolicy } : {}), approval: authorized })
      return runBudget(run.id)
    })
  },
  approveRunBudgetProfile(input) {
    object(input, [...GUARD_KEYS, 'profile', 'approval'], 'approveRunBudgetProfile')
    const profile = normalizeBudgetProfile(input.profile), authorized = approval(input.approval)
    return transaction(() => {
      const run = guard(input), budget = runBudget(run.id)
      if (!budget) throw runStoreError('BUDGET_REQUIRED', 'Configure the host-approved budget before adding a price scope')
      if (budget.profiles.some(existing => existing.id === profile.id)) return budget
      if (budget.localFreePolicy) throw runStoreError('BUDGET_IMMUTABLE', 'A local free inference policy cannot add another route or pricing scope')
      if (budget.profiles.some(existing => existing.scopeHash === profile.scopeHash)) throw runStoreError('BUDGET_IMMUTABLE', 'A pricing scope cannot replace its previously approved rates or request ceilings')
      if (budget.profiles.length >= 32) throw runStoreError('INVALID_BUDGET_PROFILE', 'Task pricing profile capacity has been reached')
      event(run.id, 'budget.profile_approved', { profile, approval: authorized })
      return runBudget(run.id)
    })
  },
  reserveModelBudget(input) {
    object(input, [...GUARD_KEYS, 'requestId', 'amountUsd', 'provider', 'model', 'kind', 'profileId', 'tokenAllowance'], 'reserveModelBudget')
    id(input.requestId, 'requestId'); budgetAmount(input.amountUsd)
    text(input.provider, 'provider', 200); text(input.model, 'model', 256)
    const kind = oneOf(input.kind ?? 'model', ['model', 'delegation'], 'kind')
    return transaction(() => {
      const run = guard(input), budget = runBudget(run.id)
      if (!budget) throw runStoreError('BUDGET_REQUIRED', 'A host-approved persistent budget is required before requesting inference')
      if (budget.localFreePolicy) {
        if (kind !== 'model' || input.amountUsd !== 0) throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'A local free inference policy authorizes only zero-USD model requests, not delegation')
        integer(input.tokenAllowance, 'tokenAllowance', 1, budget.localFreePolicy.maxTokens)
      } else if (input.tokenAllowance !== undefined) throw runStoreError('INVALID_INPUT', 'Token allowances cannot convert a paid or unapproved zero-USD budget into free inference')
      if (kind === 'model') {
        const profile = budget.profiles.find(profile => profile.id === input.profileId)
        if (!profile || profile.provider !== input.provider || profile.model !== input.model) throw runStoreError('BUDGET_PROFILE_REQUIRED', 'Model requests require an exact host-approved immutable pricing profile')
      } else if (input.profileId !== undefined) throw runStoreError('INVALID_BUDGET_PROFILE', 'Delegation reservations do not masquerade as individual model requests')
      const existing = budget.requests.find(request => request.requestId === input.requestId)
      if (existing) {
        if (existing.provider !== input.provider || existing.model !== input.model || existing.reservedUsd !== input.amountUsd || existing.kind !== kind || existing.profileId !== input.profileId || existing.tokenAllowance !== input.tokenAllowance) throw runStoreError('BUDGET_REQUEST_CONFLICT', 'A logical budget request cannot change identity, reserved amount or token allowance')
        return { fresh: false, budget, request: existing }
      }
      if (budget.requests.some(request => request.status === 'unknown')) throw runStoreError('BUDGET_OUTCOME_UNKNOWN', 'Previous billing is unknown; no additional request is authorized')
      if (Date.now() >= budget.deadlineAt) throw runStoreError('TASK_DEADLINE', 'The persistent task deadline has passed')
      if (budget.localFreePolicy) {
        if (budget.requests.some(request => request.status === 'reserved')) throw runStoreError('BUDGET_REQUEST_PENDING', 'Settle the prior local inference reservation before requesting another')
        if (budget.usedRequests >= budget.localFreePolicy.maxRequests || budget.reservedTokens + input.tokenAllowance > budget.localFreePolicy.maxTokens) throw runStoreError('TASK_BUDGET_INSUFFICIENT', 'The persistent local inference request or token allowance is exhausted')
      } else if (budget.budgetUsd === 0 || budget.spentUsd + budget.reservedUsd + budget.unknownUsd + input.amountUsd > budget.budgetUsd + Number.EPSILON * 32) throw runStoreError('TASK_BUDGET_INSUFFICIENT', 'The persistent task budget cannot cover this reservation')
      if (budget.requests.length >= 10000) throw runStoreError('BUDGET_CAPACITY', 'Task budget history reached its 10000-request safety limit')
      const request = { requestId: input.requestId, kind, provider: input.provider, model: input.model, ...(kind === 'model' ? { profileId: input.profileId } : {}), ...(budget.localFreePolicy ? { tokenAllowance: input.tokenAllowance } : {}), reservedUsd: input.amountUsd, amountUsd: null, status: 'reserved', ownerEpoch: run.owner_epoch, createdAt: Date.now(), settledAt: null }
      event(run.id, 'budget.reserved', { request })
      return { fresh: true, budget: runBudget(run.id), request }
    })
  },
  settleModelBudget(input) {
    object(input, [...GUARD_KEYS, 'requestId', 'amountUsd', 'status'], 'settleModelBudget')
    id(input.requestId, 'requestId'); oneOf(input.status, ['settled', 'unknown'], 'status')
    if (input.status === 'settled') budgetAmount(input.amountUsd)
    else if (input.amountUsd !== null) throw runStoreError('INVALID_INPUT', 'Unknown billing must not invent an actual charge')
    return transaction(() => {
      const run = guard(input, { terminal: true }), budget = runBudget(run.id)
      const existing = budget?.requests.find(request => request.requestId === input.requestId)
      if (!existing) throw runStoreError('BUDGET_REQUEST_MISSING', 'The request was not durably reserved before execution')
      if (existing.status !== 'reserved') {
        if (existing.status === input.status && existing.amountUsd === input.amountUsd) return budget
        throw runStoreError('BUDGET_RECONCILIATION_REQUIRED', 'An unknown or settled bill cannot be silently replaced; explicit evidence reconciliation is required')
      }
      if (existing.ownerEpoch !== run.owner_epoch) throw runStoreError('STALE_OWNER', 'Only the reserving host may settle an in-flight request')
      const overflow = input.status === 'settled' && (budget.localFreePolicy ? input.amountUsd !== 0 : input.amountUsd > existing.reservedUsd + Number.EPSILON * 32)
      const request = { ...existing, status: overflow ? 'unknown' : input.status, amountUsd: overflow ? null : input.amountUsd,
        reservedUsd: overflow ? input.amountUsd : existing.reservedUsd, settledAt: Date.now() }
      event(run.id, request.status === 'unknown' ? 'budget.unknown' : 'budget.settled', { request })
      return runBudget(run.id)
    })
  },
  reconcileModelBudget(input) {
    object(input, [...GUARD_KEYS, 'requestId', 'amountUsd', 'evidenceRefs', 'approval'], 'reconcileModelBudget')
    id(input.requestId, 'requestId'); budgetAmount(input.amountUsd)
    const evidenceRefs = strings(input.evidenceRefs, 'evidenceRefs', 100), authorized = approval(input.approval)
    if (!evidenceRefs.length) throw runStoreError('BUDGET_RECONCILIATION_REQUIRED', 'Billing reconciliation needs nonempty host-verified evidence')
    return transaction(() => {
      const run = guard(input, { terminal: true }), budget = runBudget(run.id)
      const existing = budget?.requests.find(request => request.requestId === input.requestId)
      if (!existing || existing.status !== 'unknown') throw runStoreError('BUDGET_RECONCILIATION_REQUIRED', 'Only an unknown bill can be reconciled')
      if (budget.localFreePolicy && input.amountUsd !== 0) throw runStoreError('INVALID_LOCAL_FREE_POLICY', 'A local free policy cannot reconcile a nonzero charge as authorized inference')
      const request = { ...existing, status: 'settled', amountUsd: input.amountUsd, settledAt: Date.now(), evidenceRefs }
      event(run.id, 'budget.reconciled', { request, approval: authorized })
      return runBudget(run.id)
    })
  },
  createBackup(input) {
    object(input, [], 'createBackup')
    return transaction(() => createRunStoreBackup(databaseFile))
  },
  listBackups(input) { object(input, [], 'listBackups'); return listRunStoreBackups(databaseFile) },
  verifyBackup(input) { object(input, ['id'], 'verifyBackup'); return verifyRunStoreBackup(databaseFile, input.id) },
  restoreBackup(input) { object(input, ['id', 'directory'], 'restoreBackup'); return restoreRunStoreBackup(databaseFile, input.id, input.directory) },
  getTaskGraph(input) {
    object(input, ['runId', 'graphId'], 'getTaskGraph'); row(input.runId); id(input.graphId, 'graphId')
    return transaction(() => taskGraph(input.runId, input.graphId), true)
  },
  listTaskGraphs(input) {
    object(input, ['runId'], 'listTaskGraphs'); row(input.runId)
    return transaction(() => taskGraphs(input.runId), true)
  },
  updateTaskGraph(input) {
    object(input, [...GUARD_KEYS, 'graphId', 'expectedGraphRevision', 'graph'], 'updateTaskGraph')
    id(input.graphId, 'graphId'); integer(input.expectedGraphRevision, 'expectedGraphRevision', 0)
    return transaction(() => {
      const run = guard(input, { terminal: true })
      const previous = taskGraph(run.id, input.graphId)
      if ((previous?.revision ?? 0) !== input.expectedGraphRevision) throw runStoreError('GRAPH_REVISION_CONFLICT', 'Task graph changed; reload before committing another transition')
      if (!previous && taskGraphs(run.id).length >= 32) throw runStoreError('INVALID_TASK_GRAPH', 'A run can contain at most 32 task graphs')
      const graph = assertTaskGraphTransition(previous, input.graph, { ownerEpoch: run.owner_epoch })
      if (graph.id !== input.graphId) throw runStoreError('INVALID_TASK_GRAPH', 'Graph identifier does not match its storage key')
      if (run.state === 'completed' || run.state === 'cancelled' && (!previous
        || !['blocked', 'cancelled'].includes(graph.status)
        || graph.nodes.some((node, index) => node.state !== previous.nodes[index].state && !['unknown', 'failed', 'cancelled'].includes(node.state)))) {
        throw runStoreError('TERMINAL_RUN', 'A cancelled parent permits only existing child cleanup, never new execution or result approval')
      }
      graph.revision = input.expectedGraphRevision + 1
      event(run.id, 'graph.updated', { graph })
      return graph
    })
  },
  createRun(input) {
    object(input, ['id', 'contract', 'ownerId', 'binding', 'initialState'], 'createRun')
    const runId = id(input.id ?? randomUUID(), 'id')
    const ownerId = id(input.ownerId, 'ownerId')
    const contract = validateTaskContract(input.contract)
    const binding = input.binding === undefined ? null : validateRunBinding(input.binding)
    const state = oneOf(input.initialState ?? 'running', ['running', 'waiting_input', 'paused'], 'initialState')
    return transaction(() => {
      if (database.prepare('SELECT id FROM runs WHERE id = ?').get(runId)) throw runStoreError('RUN_EXISTS', 'Run ID is already present')
      const now = Date.now()
      const serialized = JSON.stringify(contract)
      database.prepare('INSERT INTO runs (id, state, revision, owner_id, owner_epoch, contract_version, contract_json, created_at, updated_at, write_protocol) VALUES (?, ?, 0, ?, 1, 1, ?, ?, ?, 2)').run(runId, state, ownerId, serialized, now, now)
      database.prepare('INSERT INTO contracts VALUES (?, 1, ?, NULL, ?)').run(runId, serialized, now)
      event(runId, 'run.created', { contractVersion: 1, binding })
      return runRecord(runId)
    })
  },
  getRun(input) { object(input, ['runId'], 'getRun'); return transaction(() => runRecord(input.runId), true) },
  listRuns(input) {
    object(input, ['limit', 'states', 'sessionId', 'accountId', 'cwd', 'after'], 'listRuns')
    const limit = integer(input.limit ?? 100, 'limit', 1, 500)
    if (input.states !== undefined && (!Array.isArray(input.states) || input.states.length > RUN_STATES.length)) throw runStoreError('INVALID_INPUT', 'states must be a bounded array')
    const states = (input.states ?? RUN_STATES).map(state => oneOf(state, RUN_STATES, 'state'))
    if (!states.length) return []
    const filters = [`state IN (${states.map(() => '?').join(',')})`]
    const values = [...states]
    if (input.sessionId !== undefined) {
      id(input.sessionId, 'sessionId')
      filters.push("EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.type = 'run.created' AND json_extract(e.data_json, '$.binding.sessionId') = ?)")
      values.push(input.sessionId)
    }
    if (input.accountId !== undefined) {
      text(input.accountId, 'accountId', 160)
      filters.push("EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.type = 'run.created' AND json_extract(e.data_json, '$.binding.accountId') = ?)")
      values.push(input.accountId)
    }
    if (input.cwd !== undefined) {
      text(input.cwd, 'cwd')
      filters.push("EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.type = 'run.created' AND json_extract(e.data_json, '$.binding.cwd') = ?)")
      values.push(input.cwd)
    }
    if (input.after !== undefined) {
      object(input.after, ['updatedAt', 'id'], 'after')
      integer(input.after.updatedAt, 'after.updatedAt', 0)
      id(input.after.id, 'after.id')
      filters.push('(updated_at < ? OR (updated_at = ? AND id > ?))')
      values.push(input.after.updatedAt, input.after.updatedAt, input.after.id)
    }
    return database.prepare(`SELECT id, state, revision, owner_id AS ownerId, owner_epoch AS ownerEpoch, updated_at AS updatedAt FROM runs WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC, id LIMIT ?`).all(...values, limit)
  },
  claimRun(input) {
    object(input, ['runId', 'expectedRevision', 'expectedOwnerId', 'expectedOwnerEpoch', 'ownerId', 'approval'], 'claimRun')
    id(input.ownerId, 'ownerId')
    const authorized = approval(input.approval)
    return transaction(() => {
      const value = guard({ runId: input.runId, expectedRevision: input.expectedRevision, ownerId: input.expectedOwnerId, ownerEpoch: input.expectedOwnerEpoch }, { terminal: true })
      if (value.state === 'completed') throw runStoreError('TERMINAL_RUN', 'Completed runs do not accept new owners')
      const pending = unresolved(value.id)
      const activeTurn = runRecord(value.id).lastTurn
      database.prepare("UPDATE actions SET state = 'unknown', updated_at = ? WHERE run_id = ? AND state = 'prepared'").run(Date.now(), value.id)
      const state = value.state === 'cancelled' ? 'cancelled' : pending.length ? 'outcome_unknown' : 'paused'
      database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, owner_id = ?, owner_epoch = owner_epoch + 1, state = ? WHERE id = ?').run(input.ownerId, state, value.id)
      event(value.id, 'run.claimed', { previousOwnerId: value.owner_id, approval: authorized, unresolvedActionIds: pending.map(action => action.id) })
      for (const request of runBudget(value.id)?.requests ?? []) if (request.status === 'reserved') {
        event(value.id, 'budget.unknown', { request: { ...request, status: 'unknown', settledAt: Date.now() }, reason: 'Owner changed before a billing receipt was durably recorded' })
      }
      if (activeTurn?.status === 'running') event(value.id, 'turn.interrupted', { ...activeTurn, status: 'interrupted', endedAt: Date.now() })
      return runRecord(value.id)
    })
  },
  beginTurn(input) {
    object(input, [...GUARD_KEYS, 'turnId', 'inputHash', 'inputArtifactRef', 'hostContextRefs'], 'beginTurn')
    id(input.turnId, 'turnId')
    hash(input.inputHash, 'inputHash')
    text(input.inputArtifactRef, 'inputArtifactRef', 256)
    const hostContextRefs = strings(input.hostContextRefs ?? [], 'hostContextRefs', 10)
    return transaction(() => {
      const value = guard(input)
      const current = runRecord(value.id)
      if (value.state !== 'running' || unresolved(value.id).length) throw runStoreError('UNRESOLVED_ACTIONS', 'A new turn requires a running task without unresolved actions')
      if (!current.binding?.contractApprovalRef) throw runStoreError('APPROVAL_REQUIRED', 'A delegated run requires a host-approved bound contract')
      if (current.lastTurn?.status === 'running') throw runStoreError('TURN_ACTIVE', 'The previous turn has not settled')
      const used = database.prepare("SELECT 1 FROM events WHERE run_id = ? AND type = 'turn.started' AND json_extract(data_json, '$.id') = ?").get(value.id, input.turnId)
      if (used) throw runStoreError('TURN_EXISTS', 'Durable turn IDs are immutable and cannot be replayed')
      event(value.id, 'turn.started', { id: input.turnId, sequence: (current.lastTurn?.sequence ?? 0) + 1, inputHash: input.inputHash, inputArtifactRef: input.inputArtifactRef, hostContextRefs, status: 'running', startedAt: Date.now(), ownerEpoch: value.owner_epoch })
      return runRecord(value.id)
    })
  },
  endTurn(input) {
    object(input, [...GUARD_KEYS, 'turnId', 'state', 'resultArtifactRef', 'reason'], 'endTurn')
    id(input.turnId, 'turnId')
    oneOf(input.state, ['waiting_input', 'waiting_approval', 'paused', 'verification_failed', 'outcome_unknown', 'cancelled'], 'state')
    if (input.resultArtifactRef !== undefined) text(input.resultArtifactRef, 'resultArtifactRef', 256)
    if (input.reason !== undefined) text(input.reason, 'reason')
    return transaction(() => {
      const value = guard(input, { terminal: true })
      const turn = runRecord(value.id).lastTurn
      if (turn?.id !== input.turnId || turn?.status !== 'running') throw runStoreError('STALE_TURN', 'Only the current running turn can record its result')
      const pending = unresolved(value.id)
      // Stop requests and unknown effects outrank a late model result.
      const state = value.state === 'cancelled' ? 'cancelled' : pending.length ? 'outcome_unknown' : value.state === 'paused' ? 'paused' : input.state
      database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, state = ? WHERE id = ?').run(state, value.id)
      event(value.id, 'turn.ended', { ...turn, status: state, endedAt: Date.now(), resultArtifactRef: input.resultArtifactRef ?? null, reason: input.reason ?? null })
      return runRecord(value.id)
    })
  },
  transitionRun(input) {
    object(input, [...GUARD_KEYS, 'state', 'reason'], 'transitionRun')
    oneOf(input.state, RUN_STATES, 'state')
    if (input.reason !== undefined) text(input.reason, 'reason')
    return transaction(() => {
      const value = guard(input)
      if (input.state === 'completed') ensureComplete(value)
      if (input.state === 'running' && unresolved(value.id).some(action => database.prepare('SELECT state FROM actions WHERE run_id = ? AND id = ?').get(value.id, action.id).state === 'unknown')) throw runStoreError('UNRESOLVED_ACTIONS', 'Reconcile unknown actions before resuming execution')
      database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, state = ? WHERE id = ?').run(input.state, value.id)
      event(value.id, 'run.transitioned', { from: value.state, to: input.state, reason: input.reason ?? null })
      return runRecord(value.id)
    })
  },
  requestControl(input) {
    object(input, ['runId', 'expectedRevision', 'expectedOwnerId', 'expectedOwnerEpoch', 'kind', 'requestId', 'approval'], 'requestControl')
    oneOf(input.kind, ['pause', 'cancel'], 'control.kind')
    id(input.requestId, 'control.requestId')
    const authorized = approval(input.approval)
    return transaction(() => {
      const value = guard({ runId: input.runId, expectedRevision: input.expectedRevision, ownerId: input.expectedOwnerId, ownerEpoch: input.expectedOwnerEpoch })
      database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, state = ? WHERE id = ?').run(input.kind === 'cancel' ? 'cancelled' : 'paused', value.id)
      event(value.id, 'control.requested', { id: input.requestId, kind: input.kind, ownerEpoch: value.owner_epoch, approval: authorized })
      return runRecord(value.id)
    })
  },
  prepareAction(input) {
    object(input, [...GUARD_KEYS, 'action'], 'prepareAction')
    const action = validateAction(input.action)
    return transaction(() => {
      const value = guard(input)
      const existing = database.prepare('SELECT spec_json, state FROM actions WHERE run_id = ? AND id = ?').get(value.id, action.id)
      if (existing) {
        if (existing.spec_json !== JSON.stringify(action)) throw runStoreError('ACTION_CONFLICT', 'Logical action ID cannot be reused with different parameters')
        if (['prepared', 'unknown'].includes(existing.state)) throw runStoreError('ACTION_UNRESOLVED', 'This logical action is already pending or unknown; inspect and reconcile it, do not replay it')
        return runRecord(value.id)
      }
      if (value.state !== 'running') throw runStoreError('RUN_NOT_RUNNING', 'New actions require an actively running task')
      const now = Date.now()
      database.prepare('INSERT INTO actions VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(value.id, action.id, JSON.stringify(action), 'prepared', value.owner_epoch, now, now)
      event(value.id, 'action.prepared', { actionId: action.id })
      return runRecord(value.id)
    })
  },
  settleAction(input) {
    object(input, [...GUARD_KEYS, 'actionId', 'state', 'receipt'], 'settleAction')
    id(input.actionId, 'actionId')
    oneOf(input.state, ['succeeded', 'failed', 'unknown', 'not_applied'], 'action.state')
    object(input.receipt ?? {}, ['evidenceRefs', 'summary'], 'action.receipt')
    const receipt = { evidenceRefs: strings(input.receipt?.evidenceRefs ?? [], 'action.evidenceRefs'), summary: input.receipt?.summary === undefined ? null : text(input.receipt.summary, 'action.summary') }
    return transaction(() => {
      const value = guard(input, { terminal: true })
      const action = database.prepare('SELECT * FROM actions WHERE run_id = ? AND id = ?').get(value.id, input.actionId)
      if (!action) throw runStoreError('ACTION_NOT_FOUND', 'Logical action does not exist')
      if (!['prepared', 'unknown'].includes(action.state)) {
        if (action.state === input.state && action.receipt_json === JSON.stringify(receipt)) return runRecord(value.id)
        throw runStoreError('ACTION_FINAL', 'A resolved action cannot be rewritten')
      }
      if (action.state === 'unknown' && input.state !== 'unknown' && !receipt.evidenceRefs.length) throw runStoreError('RECONCILIATION_REQUIRED', 'Reconciling an unknown action requires evidence references')
      database.prepare('UPDATE actions SET state = ?, receipt_json = ?, updated_at = ? WHERE run_id = ? AND id = ?').run(input.state, JSON.stringify(receipt), Date.now(), value.id, action.id)
      if (input.state === 'unknown' && value.state !== 'cancelled') database.prepare("UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, state = 'outcome_unknown' WHERE id = ?").run(value.id)
      event(value.id, 'action.settled', { actionId: action.id, state: input.state, receipt })
      return runRecord(value.id)
    })
  },
  setCandidate(input) {
    object(input, [...GUARD_KEYS, 'candidateHash'], 'setCandidate')
    hash(input.candidateHash, 'candidateHash')
    return transaction(() => {
      const value = guard(input)
      if (value.candidate_hash === input.candidateHash) return runRecord(value.id)
      database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, candidate_hash = ?, candidate_generation = candidate_generation + 1 WHERE id = ?').run(input.candidateHash, value.id)
      event(value.id, 'candidate.changed', { candidateHash: input.candidateHash })
      return runRecord(value.id)
    })
  },
  recordVerification(input) {
    object(input, [...GUARD_KEYS, 'receipt'], 'recordVerification')
    const receipt = validateVerification(input.receipt)
    return transaction(() => {
      const value = guard(input)
      if (value.candidate_hash !== receipt.candidateHash) throw runStoreError('STALE_CANDIDATE', 'Verification does not match the current candidate')
      if (!JSON.parse(value.contract_json).requiredCriteria.some(criterion => criterion.id === receipt.criterionId)) throw runStoreError('UNKNOWN_CRITERION', 'Verification criterion is not part of the frozen contract')
      if (database.prepare('SELECT id FROM verifications WHERE run_id = ? AND id = ?').get(value.id, receipt.id)) throw runStoreError('RECEIPT_EXISTS', 'Verification receipts are immutable; use a new receipt ID for a new execution')
      database.prepare('INSERT INTO verifications (run_id, id, criterion_id, candidate_hash, candidate_generation, contract_version, status, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.id, receipt.id, receipt.criterionId, receipt.candidateHash, value.candidate_generation, value.contract_version, receipt.status, JSON.stringify(receipt.evidenceRefs), Date.now())
      event(value.id, 'verification.recorded', { receiptId: receipt.id, criterionId: receipt.criterionId, status: receipt.status })
      return runRecord(value.id)
    })
  },
  reviseContract(input) {
    object(input, [...GUARD_KEYS, 'contract', 'approval'], 'reviseContract')
    const contract = validateTaskContract(input.contract)
    const authorized = approval(input.approval)
    return transaction(() => {
      const value = guard(input)
      const nextVersion = value.contract_version + 1
      database.prepare('INSERT INTO contracts VALUES (?, ?, ?, ?, ?)').run(value.id, nextVersion, JSON.stringify(contract), JSON.stringify(authorized), Date.now())
      database.prepare('UPDATE runs SET write_protocol = 2, write_epoch = write_epoch + 1, contract_version = ?, contract_json = ? WHERE id = ?').run(nextVersion, JSON.stringify(contract), value.id)
      event(value.id, 'contract.revised', { version: nextVersion, approval: authorized })
      return runRecord(value.id)
    })
  },
  events(input) {
    object(input, ['runId', 'after', 'limit'], 'events')
    row(input.runId)
    const after = integer(input.after ?? 0, 'after', 0)
    const limit = integer(input.limit ?? 100, 'limit', 1, 1000)
    return database.prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(input.runId, after, limit).map(event => ({ sequence: event.sequence, runId: event.run_id, revision: event.revision, type: event.type, data: JSON.parse(event.data_json), createdAt: event.created_at }))
  }
}

function errorData(error, operation = 'request') {
  const safeCodes = ['INVALID_INPUT', 'READ_ONLY_STORE', 'RUN_NOT_FOUND', 'RUN_EXISTS', 'STALE_OWNER', 'REVISION_CONFLICT', 'TERMINAL_RUN', 'APPROVAL_REQUIRED', 'UNRESOLVED_ACTIONS', 'VERIFICATION_REQUIRED', 'ACTION_CONFLICT', 'ACTION_UNRESOLVED', 'RUN_NOT_RUNNING', 'ACTION_NOT_FOUND', 'ACTION_FINAL', 'RECONCILIATION_REQUIRED', 'STALE_CANDIDATE', 'UNKNOWN_CRITERION', 'RECEIPT_EXISTS', 'FUTURE_SCHEMA', 'MIGRATION_REQUIRED', 'INVALID_STORE', 'CORRUPT_STORE', 'UNSAFE_STORE_PATH', 'TURN_ACTIVE', 'TURN_EXISTS', 'STALE_TURN', 'INVALID_TASK_GRAPH', 'GRAPH_REVISION_CONFLICT', 'UNRESOLVED_TASK_GRAPH', 'BACKUP_INVALID']
  if (safeCodes.includes(error.code) || ['BUDGET_IMMUTABLE', 'BUDGET_REQUIRED', 'BUDGET_REQUEST_CONFLICT', 'BUDGET_OUTCOME_UNKNOWN', 'TASK_DEADLINE', 'TASK_BUDGET_INSUFFICIENT', 'BUDGET_CAPACITY', 'BUDGET_RECONCILIATION_REQUIRED', 'BUDGET_REQUEST_MISSING', 'INVALID_BUDGET_PROFILE', 'BUDGET_PROFILE_REQUIRED', 'INVALID_LOCAL_FREE_POLICY', 'BUDGET_REQUEST_PENDING'].includes(error.code)) return { code: error.code, message: error.message }
  return redactedStorageFailure(error, operation)
}

try {
  await initialize(process.argv[2])
  process.send({ type: 'ready' })
} catch (error) {
  try { database?.close() } catch {}
  process.send({ type: 'startup_error', ...errorData(error, 'initialize') }, () => process.exit(1))
}

process.on('message', raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const message = /** @type {{id?:number, method?:string, input?:unknown}} */ (raw)
  if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') return
  if (message.method === 'close') {
    try { database.close(); process.send({ id: message.id, result: null }, () => process.exit(0)) } catch (error) { process.send({ id: message.id, error: errorData(error, 'close') }, () => process.exit(1)) }
    return
  }
  try {
    if (!Object.hasOwn(methods, message.method)) throw runStoreError('INVALID_INPUT', 'Unsupported run storage method')
    if (database.prepare('PRAGMA user_version').get().user_version !== RUN_STORE_SCHEMA_VERSION) throw runStoreError('FUTURE_SCHEMA', 'Run schema changed after opening; reconnect with a compatible runtime')
    if (readOnly && !['getRun', 'listRuns', 'events', 'getTaskGraph', 'listTaskGraphs', 'getRunBudget', 'listBackups', 'verifyBackup'].includes(message.method)) throw runStoreError('READ_ONLY_STORE', 'Read-only storage cannot mutate tasks, actions or verification')
    const result = methods[message.method](message.input)
    process.send({ id: message.id, result })
  } catch (error) { process.send({ id: message.id, error: errorData(error, message.method) }) }
})

process.on('disconnect', () => { try { database?.close() } catch {} process.exit(0) })
