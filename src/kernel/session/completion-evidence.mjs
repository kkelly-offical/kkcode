import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseShellCommands } from '../permission/shell-analysis.mjs'
import { toolCapability } from '../permission/rules.mjs'
import { isReconciledCompletionEvent, completionEnvironmentIdentity } from './completion-history.mjs'
import { completionVerificationGuidance } from './verification-guidance.mjs'
import { isToolNotStarted } from '../core/execution-outcome.mjs'

const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'patch', 'notebookedit', 'move', 'copy', 'remove', 'mkdir', 'archive', 'git_apply_patch', 'git_restore', 'office_create', 'office_edit', 'office_pdf'])
const NON_CHECK_FLAGS = /^(?:--help|-h|--version|--list(?:Tests|-tests)?|-list|--collect-only|--co|--setup-plan|--setup-only|--dry-run|--showConfig|--listFilesOnly|--print-config|--init|--fixtures(?:-per-test)?|--markers|--if-present|--ignore-scripts|--passWithNoTests|--watch(?:All)?|--fix)(?:=|$)/i
const SCRIPT = /^(?:test|build|lint|typecheck|type-check|check)(?::[a-zA-Z0-9_-]+)*$/
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)

function executable(word) { return String(word || '').replace(/\\/g, '/').split('/').at(-1).replace(/\.(?:exe|cmd)$/i, '') }

function stripEnvironment(words) {
  const args = [...words], env = []
  if (args[0] === 'env') { args.shift(); if (args[0] === '--') args.shift() }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] || '')) {
    const assignment = args.shift(), separator = assignment.indexOf('='), key = assignment.slice(0, separator)
    const identity = completionEnvironmentIdentity({ [key]: assignment.slice(separator + 1) })
    if (!identity) return null
    env.push(...identity)
  }
  if (!args.length || args[0].startsWith('-')) return null
  return { words: args, env }
}

function simpleCheck(words) {
  if (!words.length || words.some(word => NON_CHECK_FLAGS.test(word) || /(?:^|:)fix(?:$|:)/i.test(word) || word === '--fix')) return null
  let binary = executable(words[0]), args = words.slice(1)
  if (['npx', 'bunx'].includes(binary)) {
    if (args[0] === '--no-install') args = args.slice(1)
    if (!args[0] || args[0].startsWith('-')) return null
    binary = executable(args[0]); args = args.slice(1)
  } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(binary) && ['exec', 'x'].includes(args[0])) {
    args = args.slice(1); if (args[0] === '--') args = args.slice(1)
    if (!args[0] || args[0].startsWith('-')) return null
    binary = executable(args[0]); args = args.slice(1)
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(binary)) {
    if (args[0] === 'run' || args[0] === 'run-script') args = args.slice(1)
    if (SCRIPT.test(args[0] || '')) return { label: `${binary} ${args[0]}`, kind: 'project' }
  }
  if (binary === 'go' && ['test', 'vet', 'build'].includes(args[0]) && !args.includes('-n')) return { label: `go ${args[0]}`, kind: 'project' }
  if (binary === 'cargo' && ['test', 'check', 'clippy', 'build'].includes(args[0])) return { label: `cargo ${args[0]}`, kind: 'project' }
  if (/^python(?:3(?:\.\d+)?)?$/.test(binary) && args[0] === '-m' && ['pytest', 'compileall', 'py_compile', 'unittest'].includes(args[1])) return { label: `python -m ${args[1]}`, kind: 'project' }
  if (binary === 'node' && ['--test', '--check', '-c'].includes(args[0]) && !args.some(arg => /^(?:-e|--eval|-p|--print)(?:=|$)/.test(arg)) &&
      (args[0] === '--test' || args.slice(1).some(arg => arg && !arg.startsWith('-')))) return { label: args[0] === '--test' ? 'node --test' : 'node --check', kind: 'project' }
  if (['tsc', 'pytest', 'vitest', 'jest', 'eslint'].includes(binary) && !(binary !== 'pytest' && args.includes('-v')) && !(binary === 'vitest' && ['list', 'init', 'related'].includes(args[0]))) return { label: binary, kind: 'project' }
  if (binary === 'playwright' && args[0] === 'test') return { label: 'playwright test', kind: 'project' }
  if (binary === 'git' && args[0] === 'diff' && args.includes('--check') && !args.some(arg => arg === '--output' || arg.startsWith('--output='))) return { label: 'git diff --check', kind: 'documentation' }
  return null
}

/** Recognition is deliberately conservative. Shell output is never parsed as
 * proof, and zero exit from a masking shell expression is not a check receipt. */
export function classifyVerificationCommand(command, { cwd = process.cwd(), env = null } = {}) {
  const toolEnvironment = completionEnvironmentIdentity(env)
  if (!toolEnvironment) return null
  const parsed = parseShellCommands(command), commands = parsed.commands
  if (parsed.uncertain || !commands.length || commands.some((entry, index) => entry.dynamic || entry.glob || entry.redirects.length || entry.separator !== (index === commands.length - 1 ? null : '&&'))) return null
  let directory = path.resolve(cwd)
  const checks = []
  for (const entry of commands) {
    const normalized = stripEnvironment(entry.words)
    if (!normalized) return null
    const { words, env } = normalized
    if (words[0] === 'cd' && checks.length === 0 && !env.length) {
      const args = words[1] === '--' ? words.slice(2) : words.slice(1)
      if (args.length !== 1 || args[0].startsWith('-') || args[0].startsWith('~')) return null
      directory = path.resolve(directory, args[0]); continue
    }
    const check = simpleCheck(words)
    if (!check) return null
    const effectiveEnv = [...new Map([...toolEnvironment, ...env]).entries()].sort(([a], [b]) => a.localeCompare(b))
    checks.push({ ...check, id: digest({ directory, env: effectiveEnv, words }) })
  }
  return checks.length ? { id: digest(checks.map(check => check.id)), checks } : null
}

function successful(event) {
  const metadata = event.metadata || {}, evidence = event.evidence || {}
  return event.status === 'completed' && event.ok !== false && !event.error &&
    !['timedOut', 'cancelled', 'captureIncomplete', 'terminationIncomplete', 'outcomeUnknown'].some(key => event[key] === true || metadata[key] === true) &&
    [event.exitCode, metadata.exitCode, evidence.exitCode].every(code => code == null || code === 0)
}

function processVerified(event) {
  return successful(event) && event.metadata?.started !== false && [event.exitCode, event.metadata?.exitCode, event.evidence?.exitCode].includes(0)
}

function attemptedChecks(command, cwd, env = null) {
  const toolEnvironment = completionEnvironmentIdentity(env)
  if (!toolEnvironment) return []
  let directory = path.resolve(cwd)
  const checks = []
  let directoryKnown = true
  for (const entry of parseShellCommands(command).commands) {
    const normalized = stripEnvironment(entry.words)
    if (!normalized) continue
    if (normalized.words[0] === 'cd') {
      const args = normalized.words[1] === '--' ? normalized.words.slice(2) : normalized.words.slice(1)
      // Only && proves that the following check ran after successful cd. A
      // dynamic/conditional directory must never acquire a false root identity.
      if (!entry.dynamic && !entry.glob && !entry.redirects.length && !normalized.env.length && args.length === 1 && !args[0].startsWith('-') && !args[0].startsWith('~') && entry.separator === '&&' && (directoryKnown || path.isAbsolute(args[0]))) {
        directory = path.resolve(directory, args[0]); directoryKnown = true
      } else directoryKnown = false
      continue
    }
    const check = simpleCheck(normalized.words)
    const effectiveEnv = [...new Map([...toolEnvironment, ...normalized.env]).entries()].sort(([a], [b]) => a.localeCompare(b))
    if (check) checks.push({ ...check, id: digest({ directory: directoryKnown ? directory : {unknownScope: digest(command)}, env: effectiveEnv, words: normalized.words }) })
  }
  return checks
}

function mutationPaths(event) {
  const metadata = event.metadata || {}, args = event.args || {}
  const changes = [...(Array.isArray(metadata.fileChanges) ? metadata.fileChanges : []), ...(Array.isArray(event.evidence?.fileChanges) ? event.evidence.fileChanges : []),
    ...(Array.isArray(metadata.mutations) ? metadata.mutations : []), ...(metadata.mutation ? [metadata.mutation] : [])]
  const found = changes.map(change => change?.path || change?.filePath || change?.target).filter(value => typeof value === 'string')
  if (!found.length) for (const key of ['path', 'file_path', 'filePath', 'from', 'to']) if (typeof args[key] === 'string') found.push(args[key])
  if (!found.length && Array.isArray(args.changes)) for (const change of args.changes) for (const key of ['path', 'file_path', 'filePath', 'from', 'to']) if (typeof change?.[key] === 'string') found.push(change[key])
  return found
}

function hasMutation(event, verification) {
  if (isToolNotStarted(event)) return false
  const metadata = event.metadata || {}
  if (Array.isArray(metadata.fileChanges) && metadata.fileChanges.length || Array.isArray(event.evidence?.fileChanges) && event.evidence.fileChanges.length || metadata.mutation || Array.isArray(metadata.mutations) && metadata.mutations.length) return true
  if (EDIT_TOOLS.has(event.name)) return successful(event) || isReconciledCompletionEvent(event)
  if (event.name !== 'bash' || verification || !['completed', 'error', 'cancelled'].includes(event.status) || event.metadata?.started === false) return false
  const parsed = parseShellCommands(event.args?.command)
  if (event.metadata?.verificationEnvUnknown !== true && completionEnvironmentIdentity(event.args?.env) && !parsed.uncertain && parsed.commands.length && parsed.commands.every(entry => !entry.dynamic && !entry.glob && !entry.redirects.length && ['echo', 'printf', 'true', 'pwd'].includes(entry.words[0]))) return false
  return event.metadata?.verificationEnvUnknown === true || toolCapability('bash', event.args?.command, { args: event.args }) !== 'safe-shell'
}

/** Host event chronology only: report observed checks, never semantic acceptance.
 * `toolEvents` must be the current host-recorded execution slice, not model text. */
export function evaluateCompletionEvidence({ todoState = null, toolEvents = [], requireChecks = false, cwd = process.cwd(), language = 'en' } = {}) {
  const todos = Array.isArray(todoState) ? todoState : Array.isArray(todoState?.items) ? todoState.items : []
  const pending = todos.filter(item => !['completed', 'cancelled'].includes(item?.status))
  const failures = [], observations = [], unresolved = new Map(), failedMutations = new Map()
  let lastMutation = -1, mutations = 0, docsOnly = true
  for (const [index, event] of toolEvents.entries()) {
    if (!event || typeof event !== 'object') continue
    if (event.metadata?.completionHistoryIncomplete === true) failures.push({ kind: 'history_inspection_required', index })
    if (event.outcomeUnknown === true || event.metadata?.outcomeUnknown === true || event.metadata?.terminationIncomplete === true) failures.push({ kind: 'unknown_effect', index, tool: String(event.name || 'tool').slice(0, 60) })
    const eventCwd = path.resolve(cwd, event.args?.cwd || '.')
    const verification = event.name === 'bash' && event.metadata?.verificationEnvUnknown !== true ? classifyVerificationCommand(event.args?.command, { cwd: eventCwd, env: event.args?.env }) : null
    if (EDIT_TOOLS.has(event.name)) {
      const paths = [...new Set(mutationPaths(event).map(file => path.resolve(eventCwd, file)))]
      const keys = paths.length ? paths.map(file => digest({path: file})) : [digest({cwd: eventCwd, unknownPath: event.name})]
      for (const key of keys) {
        if (successful(event)) failedMutations.delete(key)
        else if (!isToolNotStarted(event) && !isReconciledCompletionEvent(event)) failedMutations.set(key, { kind: 'failed_mutation', index, tool: String(event.name).slice(0, 60) })
      }
    }
    if (hasMutation(event, verification)) {
      mutations++; lastMutation = index
      const paths = mutationPaths(event)
      if (!paths.length || paths.some(file => !/\.(?:md|mdx|rst|txt|adoc)$/i.test(file))) docsOnly = false
    }
    if (!verification) {
      // A masked/ambiguous test expression is not proof of success even if its
      // final shell exit is zero. Keep that attempted check unresolved until a
      // trustworthy execution of the same check, not an unrelated success.
      if (event.name === 'bash' && event.metadata?.verificationEnvUnknown !== true) for (const check of attemptedChecks(event.args?.command, eventCwd, event.args?.env)) {
        const id = digest([check.id])
        unresolved.set(id, { kind: 'unverified_check', id, label: check.label, status: 'unverified', index })
      }
      continue
    }
    const passed = processVerified(event)
    const record = { id: verification.id, label: verification.checks.map(check => check.label).join(' && ').slice(0, 180), status: passed ? 'passed' : 'failed', index, kind: verification.checks.some(check => check.kind === 'project') ? 'project' : 'documentation' }
    observations.push(record)
    if (!passed) unresolved.set(verification.id, { ...record, kind: 'failed_check' })
    else {
      unresolved.delete(verification.id)
      // Successful && chains prove each member ran successfully. A failed
      // chain identifies no particular member, so only that chain clears it.
      for (const check of verification.checks) unresolved.delete(digest([check.id]))
    }
  }
  failures.push(...unresolved.values(), ...failedMutations.values())
  const recentChecks = observations.filter(check => check.status === 'passed' && check.index > lastMutation && (check.kind === 'project' || mutations > 0 && docsOnly))
  const checksRequired = requireChecks === true || mutations > 0
  if (pending.length) failures.push({ kind: 'blocking_todo', count: pending.length })
  if (checksRequired && !recentChecks.length) failures.push({ kind: 'checks_required', afterIndex: lastMutation })
  const passed = failures.length === 0
  const state = passed ? recentChecks.length ? 'checks_observed' : 'not_verified' : failures.some(failure => failure.kind === 'unknown_effect') ? 'outcome_unknown' : pending.length ? 'work_remaining' : 'needs_verification'
  const failureKinds = [...new Set(failures.map(failure => failure.kind))]
  const chinese = typeof language === 'string' && (language === 'zh' || language.startsWith('zh-'))
  const blockedMessage = chinese
    ? `完成验收被阻断：${failureKinds.join(', ')}。请检查已有执行记录，通过正常工具和权限路径补齐检查；不得把未知效果标成成功或重复执行。`
    : `Completion is blocked: ${failureKinds.join(', ')}. Inspect existing evidence and run appropriate checks through the normal approved tool path; do not claim completion or replay unknown effects.`
  const repairGuidance = [
    ...(failureKinds.includes('checks_required') ? [completionVerificationGuidance(language)] : []),
    ...(failureKinds.some(kind => ['failed_check', 'unverified_check'].includes(kind)) ? [chinese
      ? '已有失败或未能核实的检查仍须修复，并以相同参数、工作目录和环境重新执行同一检查。无关检查成功不能清除它；不要隐藏错误或跳过原测试。'
      : 'Repair failed or unverified checks and rerun the same checks with the same arguments, working directory and environment. An unrelated successful check cannot clear them; do not hide errors or skip the original tests.'] : [])
  ].join('\n')
  const unresolvedChecks = failures.filter(failure => ['failed_check', 'unverified_check'].includes(failure.kind)).slice(-8)
  const checkDetails = unresolvedChecks.length ? [chinese ? '尚未核实的检查（定位原始工具记录；不是新执行授权）：' : 'Unresolved checks (locate the original tool record; not new execution authority):',
    ...unresolvedChecks.map(check => `${check.label} · ${check.id} · #${check.index}`)].join('\n') : ''
  return {
    passed, verdict: passed ? state === 'checks_observed' ? 'CHECKS_OBSERVED' : 'NO_BLOCKING_TODO' : 'BLOCK', state,
    checks: observations.slice(-20), failures: failures.slice(-20),
    message: state === 'checks_observed'
      ? 'Successful check processes were observed after the latest mutation. This is not full semantic acceptance; report their actual scope and remaining limits.'
      : passed ? 'No blocking todo or observed mutation requires verification. An empty todo list is not proof that tests passed; build/test/lint commands are not executed implicitly.'
        : [blockedMessage, repairGuidance, checkDetails].filter(Boolean).join('\n')
  }
}
