import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { access, realpath } from 'node:fs/promises'
import { userRootDir } from '../../storage/paths.mjs'
import { acquireProcessLock } from '../../storage/process-lock.mjs'
import { openRunStore } from '../../storage/run-store.mjs'
import { validateTaskContract, validateAction, runStoreError } from '../../storage/run-store-contracts.mjs'
import { createDurableRunBinding, withDurableRun, currentDurableRun } from './run-runtime.mjs'
import { createRunSpec } from './run-spec.mjs'
import { isDelegatedKernel } from '../isolation/delegation-kernel.mjs'
import { prepareHostAcceptance, restoreHostAcceptance, captureAcceptanceCandidate } from '../session/acceptance-manifest.mjs'
import { flushNow } from '../session/store.mjs'
import { createScopedGrantAuthority } from '../permission/scoped-grants.mjs'
import { evaluatePermission, normalizePermissionLevel } from '../permission/rules.mjs'
import { createVerificationRunner } from '../isolation/verification-workspace.mjs'
import { createTaskArtifactAccess } from '../tool/artifacts.mjs'
import { resolveTaskModel } from '../provider/task-model.mjs'
import { repairRunHistory } from './run-recovery.mjs'
import { isTaskGraphHost } from './task-graph-runtime.mjs'
import { withRequestBudget } from '../../usage/request-budget.mjs'
import { prepareBudgetProfiles, prepareBudgetProfile, budgetRoute, normalizeBudgetProfile } from '../../usage/budget-profiles.mjs'
import { normalizeRunHostBinding, verifyRunHostBinding } from './run-host-binding.mjs'
import { localFreePolicy, validateLocalFreeBudget } from '../../usage/local-free.mjs'
import { runControlledGit } from '../../util/controlled-git.mjs'

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const fail = (code, message) => { throw runStoreError(code, message) }
const guard = row => ({ runId: row.id, expectedRevision: row.revision, ownerId: row.ownerId, ownerEpoch: row.ownerEpoch })
const terminal = state => ['completed', 'cancelled'].includes(state)
const hasUnknown = run => run.actions.some(action => ['prepared', 'unknown'].includes(action.state))
async function assertTaskWorkspace(cwd) {
  const result = await runControlledGit(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd, timeoutMs: 10_000, maxBuffer: 64 * 1024 })
  if (!result.ok) fail('TASK_WORKSPACE_REQUIRED', '委托任务必须使用从固定基线创建的独立 Git 工作树。')
  const paths = result.stdout.trim().split(/\r?\n/)
  if (paths.length !== 3) fail('TASK_WORKSPACE_REQUIRED', '无法确认独立工作树身份。')
  const [gitDir, commonDir, root] = await Promise.all(paths.map(value => realpath(value)))
  if (gitDir === commonDir || root !== await realpath(cwd) || !gitDir.startsWith(path.join(commonDir, 'worktrees') + path.sep)) fail('TASK_WORKSPACE_REQUIRED', '不能在用户主工作区执行委托任务，请先创建独立工作树。')
  return { cwd: root, gitDir, commonDir }
}

/**
 * Trusted host-only controller. authorize is a function supplied by CLI/SDK UI;
 * no model/tool payload can create grants, acceptance boundaries or ownership.
 * The caller owns store/kernel lifetime and must create a dedicated safe kernel.
 */
export function createRunCoordinator(options) {
  const { kernel, store, artifacts, actor: suppliedActor, authorize, executionBackend, acceptance = null } = options || {}
  const actor = Object.freeze({ accountId: suppliedActor?.accountId, projectId: suppliedActor?.projectId })
  const hostBindingHash = normalizeRunHostBinding(options?.hostBindingHash ?? null)
  const freePolicy = options?.localFreeAuthorization ? localFreePolicy(options.localFreeAuthorization) : null
  if (freePolicy && options.taskGraph) fail('LOCAL_FREE_AUTHORIZATION', '本机免费评测暂不授权任务图转授。')
  if (!isDelegatedKernel(kernel)) fail('DELEGATION_KERNEL_REQUIRED', '委托任务必须使用独立、禁用宿主扩展的受控内核。')
  if (!store?.beginTurn || !artifacts?.put || typeof authorize !== 'function' || typeof executionBackend?.ensureReady !== 'function' || typeof executionBackend?.executeTool !== 'function') fail('INVALID_COORDINATOR', '缺少持久账本、产物、宿主授权或严格执行后端。')
  if (!actor || !['accountId', 'projectId'].every(key => typeof actor[key] === 'string' && /^[A-Za-z0-9_.:@-]{1,160}$/.test(actor[key]))) fail('INVALID_ACTOR', '账号和项目范围必须由宿主身份系统提供。')
  if (options.taskGraph && !isTaskGraphHost(options.taskGraph)) fail('TASK_GRAPH_HOST_REQUIRED', '委派能力必须由真实任务图宿主创建，不能从 JSON 恢复。')
  if (options.modelRole !== undefined && !['review', 'implementation'].includes(options.modelRole)) fail('INVALID_MODEL_ROLE', '执行模型职责必须由宿主明确选择。')
  if (options.toolAllowlist !== undefined && (!Array.isArray(options.toolAllowlist) || options.toolAllowlist.some(tool => typeof tool !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(tool)))) fail('INVALID_TOOL_SCOPE', '子任务工具白名单必须为宿主确认的精确名称。')
  const allowedTools = () => (executionBackend.allowedToolNames || []).filter(tool => (!['task', 'task_group'].includes(tool) || isTaskGraphHost(options.taskGraph)) && (!options.toolAllowlist || options.toolAllowlist.includes(tool)))
  const ownerId = options.ownerId || `host_${process.pid}_${randomUUID()}`
  const leaseDirectory = options.leaseDirectory || path.join(userRootDir(), 'run-execution-locks')
  const ownership = new Map(), active = new Map(), queues = new Map(), grants = new Map(), externalLeases = new Map()
  const toolConfirmations = new Map()
  let closed = false
  let authorityPromise
  const authority = () => authorityPromise ??= Promise.resolve(options.grantAuthority || createScopedGrantAuthority({ rootDir: options.grantDirectory || path.join(userRootDir(), 'scoped-grants') }))
  const grantBinding = (run, action) => ({ principal: `${actor.accountId}:${actor.projectId}`, taskId: run.id, action: action.kind, resource: action.target, resourceVersion: `${run.contractVersion}:${run.ownerEpoch}:${run.candidateHash || 'unsealed'}`, operationId: action.id, args: { parameterHash: action.parameterHash, effect: action.effect, retryPolicy: action.retryPolicy } })
  kernel.prompts.permission.setPermissionPromptInterceptor(async request => {
    const binding = currentDurableRun()
    if (!binding || !active.has(binding.runId)) return 'deny'
    const run = await owned(binding.runId)
    const config = kernel.configState.config
    if (normalizePermissionLevel(config.permission) === 'readonly') return 'deny'
    const decision = evaluatePermission({ config, tool: request.tool, mode: 'assistant', pattern: request.pattern, command: request.command, risk: request.risk, workspace: run.binding.cwd })
    if (decision.action === 'deny' || !allowedTools().includes(request.tool)) return 'deny'
    const delegatedTool = (run.contract.allowedTools || []).includes(request.tool)
    if (delegatedTool && !['rule', 'protected_path', 'sensitive_path'].includes(decision.source) && (['read', 'list', 'todowrite'].includes(request.tool) || run.contract.allowedPaths.length)) return 'allow_once'
    try {
      const approval = await confirm({ kind: 'run.tool', runId: run.id, ownerEpoch: run.ownerEpoch, revision: run.revision, tool: request.tool, target: request.pattern, parameterHash: digest(canonical(request.args)), args: request.args, reason: request.reason })
      const current = await owned(run.id)
      if (current.revision !== run.revision || current.contractVersion !== run.contractVersion || terminal(current.state)) return 'deny'
      toolConfirmations.set(`${run.id}:${binding.turnId}:${request.tool}:${digest(canonical(request.args))}`, approval)
      return 'allow_once'
    } catch (error) { if (error.code === 'APPROVAL_REQUIRED') return 'deny'; throw error }
  })
  const unsubscribe = kernel.events.subscribe(async event => {
    if (!['permission.asked', 'permission.decided'].includes(event.type)) return
    for (const [runId, execution] of active) {
      if (execution.sessionId !== event.sessionId || execution.controller.signal.aborted) continue
      await serialized(runId, async () => {
        const current = await owned(runId)
        if (event.type === 'permission.asked' && current.state === 'running') await store.transitionRun({ ...guard(current), state: 'waiting_approval', reason: 'Kernel is awaiting a host permission decision' })
        if (event.type === 'permission.decided' && current.state === 'waiting_approval') await store.transitionRun({ ...guard(current), state: 'running', reason: 'Host permission decision returned' })
      })
    }
  })

  function serialized(runId, operation) {
    const previous = queues.get(runId) || Promise.resolve()
    const next = previous.then(operation, operation)
    queues.set(runId, next.catch(() => {}))
    return next
  }

  async function inspect(runId) {
    const run = await store.getRun(runId)
    if (!run.binding || run.binding.accountId !== actor.accountId || run.binding.projectId !== actor.projectId || path.resolve(run.binding.cwd) !== path.resolve(kernel.cwd)) fail('RUN_SCOPE_MISMATCH', '任务不属于当前账号、项目或工作区。')
    return run
  }

  async function owned(runId) {
    if (closed) fail('COORDINATOR_CLOSED', '任务协调器已关闭。')
    const run = await inspect(runId)
    if (run.ownerId !== ownerId || ownership.get(runId) !== run.ownerEpoch) fail('STALE_OWNER', '任务执行权已变化，请重新检查并授权接管。')
    return run
  }

  const scopedActor = run => ({ ...actor, sessionId: run.binding.sessionId, runId: run.id })
  const persist = async (run, value, kind = 'system', operationId) => artifacts.put({ actor: scopedActor(run), content: JSON.stringify(value), mime: 'application/json', source: { kind, ...(operationId ? { operationId } : {}) } })
  async function readJson(run, artifactId) {
    const metadata = await artifacts.getMetadata({ actor: scopedActor(run), id: artifactId })
    if (metadata.size > 4 * 1024 * 1024) fail('HOST_CONTEXT_TOO_LARGE', '恢复资料超过安全读取上限。')
    const pieces = []; let cursor, total = 0
    do {
      const page = await artifacts.read({ actor: scopedActor(run), id: artifactId, cursor, limit: 256 * 1024 })
      const part = Buffer.from(page.data, 'base64'); total += part.length
      if (total > 4 * 1024 * 1024) fail('HOST_CONTEXT_TOO_LARGE', '恢复资料超过安全读取上限。')
      pieces.push(part); cursor = page.nextCursor
    } while (cursor)
    return JSON.parse(Buffer.concat(pieces).toString('utf8'))
  }

  async function confirm(request) {
    // The callback invocation, not a boolean inside model-produced JSON, is the boundary.
    const result = await authorize(freeze(structuredClone({ ...request, actor })))
    if (result === true) return { approved: true, actorId: ownerId, reason: `Host confirmed ${request.kind}` }
    if (result && typeof result.actorId === 'string' && typeof result.reason === 'string' && result.reason.trim()) return { approved: true, actorId: result.actorId, reason: result.reason }
    fail('APPROVAL_REQUIRED', '宿主未确认本次委托或高影响操作，未执行。')
  }

  async function start(input) {
    if (closed) fail('COORDINATOR_CLOSED', '任务协调器已关闭。')
    const contract = validateTaskContract(input.contract)
    if (!contract.requiredCriteria.length) fail('VERIFICATION_REQUIRED', '委托任务至少需要一项明确的验收标准。')
    const cwd = await realpath(kernel.cwd)
    const workspaceIdentity = await assertTaskWorkspace(cwd)
    const id = input.id || `run_${randomUUID()}`
    const sessionId = input.sessionId || `ses_${randomUUID().replaceAll('-', '')}`
    const limits = freeze(structuredClone(input.limits || { budgetUsd: 0, deadlineAt: Date.now() + 3600000 }))
    if (!limits || typeof limits !== 'object' || Object.keys(limits).some(key => !['budgetUsd', 'deadlineAt'].includes(key)) || !Number.isFinite(limits.budgetUsd) || limits.budgetUsd < 0 || limits.budgetUsd > 1_000_000 || !Number.isSafeInteger(limits.deadlineAt) || limits.deadlineAt <= Date.now() || limits.deadlineAt - Date.now() > 7 * 86400000) fail('INVALID_RUN_LIMITS', '新委托必须明确有限 USD 预算与未来七天内的绝对期限；缺省预算为零。')
    const profiles = limits.budgetUsd > 0 || freePolicy ? options.budgetProfiles?.length
      ? options.budgetProfiles.map(normalizeBudgetProfile) : await prepareBudgetProfiles(kernel.configState) : []
    if (freePolicy) validateLocalFreeBudget(options.localFreeAuthorization, { budgetUsd: limits.budgetUsd, profiles })
    const approval = await confirm({ kind: 'run.contract', runId: id, cwd, contract, limits, profiles, hostBindingHash, ...(freePolicy ? { localFreePolicy: freePolicy } : {}) })
    const provisional = { id, binding: { sessionId, cwd, ...actor } }
    if (JSON.stringify(await assertTaskWorkspace(cwd)) !== JSON.stringify(workspaceIdentity)) fail('WORKSPACE_CHANGED', '确认期间工作树身份已变化，未创建委托。')
    const approvalArtifact = await persist(provisional, { schema: 'kk.run-contract-approval.v1', contractHash: digest(canonical(contract)), workspaceIdentity, limits, approval, hostBindingHash })
    const run = await store.createRun({ id, ownerId, contract, initialState: 'waiting_input', binding: { ...provisional.binding, contractApprovalRef: approvalArtifact.id } })
    ownership.set(run.id, run.ownerEpoch)
    await store.configureRunBudget({ ...guard(run), ...limits, profiles, approval, ...(freePolicy ? { localFreePolicy: freePolicy } : {}) })
    return owned(run.id)
  }

  async function attach(input) {
    if (active.has(input.runId)) fail('TURN_ACTIVE', '当前宿主已在执行该任务。')
    const lease = await acquireProcessLock(path.join(leaseDirectory, `${digest(input.runId)}.lock`))
    try {
      const before = await inspect(input.runId)
      await verifyRunHostBinding({ run: before, artifacts, hostBindingHash })
      if (input.expectedRevision !== undefined && before.revision !== input.expectedRevision || input.expectedOwnerEpoch !== undefined && before.ownerEpoch !== input.expectedOwnerEpoch) fail('REVISION_CONFLICT', '待接管任务已变化，请重新查看后确认。')
      if (before.state === 'completed' || before.state === 'cancelled' && !hasUnknown(before)) fail('TERMINAL_RUN', '已结束的任务不能重新执行；取消任务的未知结果仍需核查。')
      const approval = await confirm({ kind: 'run.takeover', runId: before.id, previousOwnerId: before.ownerId, previousOwnerEpoch: before.ownerEpoch, revision: before.revision, unknownActionIds: before.actions.filter(action => ['prepared', 'unknown'].includes(action.state)).map(action => action.id) })
      const run = await store.claimRun({ runId: before.id, expectedRevision: before.revision, expectedOwnerId: before.ownerId, expectedOwnerEpoch: before.ownerEpoch, ownerId, approval })
      ownership.set(run.id, run.ownerEpoch)
      return run
    } finally { await lease.release() }
  }

  async function stop(input, state) {
    if (!ownership.has(input.runId)) {
      const before = await inspect(input.runId)
      if (input.expectedRevision !== undefined && input.expectedRevision !== before.revision || input.expectedOwnerEpoch !== undefined && input.expectedOwnerEpoch !== before.ownerEpoch) fail('REVISION_CONFLICT', '控制请求基于过期任务版本，请重新检查。')
      const kind = state === 'cancelled' ? 'cancel' : 'pause'
      const approval = await confirm({ kind: `run.${kind}`, runId: before.id, revision: before.revision, ownerEpoch: before.ownerEpoch, candidateHash: before.candidateHash })
      return store.requestControl({ runId: before.id, expectedRevision: before.revision, expectedOwnerId: before.ownerId, expectedOwnerEpoch: before.ownerEpoch, kind, requestId: `control_${randomUUID()}`, approval })
    }
    const run = await serialized(input.runId, async () => {
      const current = await owned(input.runId)
      if (terminal(current.state)) return current
      return store.transitionRun({ ...guard(current), state, reason: input.reason || `Host requested ${state}` })
    })
    active.get(input.runId)?.controller.abort(runStoreError(state === 'cancelled' ? 'RUN_CANCELLED' : 'RUN_PAUSED', '宿主已要求停止；正在收束操作并保留成果。'))
    return run
  }

  function actionAdapter(runId) {
    return Object.freeze({
      async lookup(intent) {
        if (active.has(runId) || externalLeases.has(runId)) fail('ACTION_STILL_RUNNING', '原始执行仍在进行，必须等待收束后才能独立核查并结算。')
        const action = validateAction(intent), run = await owned(runId)
        if (active.has(runId) || externalLeases.has(runId)) fail('ACTION_STILL_RUNNING', '核查期间原始执行仍在进行。')
        const previous = run.actions.find(entry => entry.id === action.id)
        if (!previous) return null
        if (['kind', 'target', 'parameterHash', 'effect', 'retryPolicy'].some(key => previous[key] !== action[key]) || JSON.stringify(previous.context) !== JSON.stringify(action.context)) fail('ACTION_CONFLICT', '只读核查必须匹配原持久意图的全部范围和参数。')
        return { fresh: false, state: previous.state, receipt: previous.receipt }
      },
      async authorize(intent) {
        const action = validateAction(intent)
        const before = await owned(runId)
        if (!before.contract.allowedExternalActions.includes(action.kind) || !['running', 'waiting_input', 'outcome_unknown'].includes(before.state) || hasUnknown(before) && !before.actions.some(existing => existing.id === action.id && ['prepared', 'unknown'].includes(existing.state))) return false
        try {
          const existing = grants.get(`${runId}:${action.id}`)
          if (existing) {
            if (existing.hash !== digest(canonical(action))) return false
            await (await authority()).verifyContinuation(existing.token, grantBinding(before, action))
            return true
          }
          const approval = await confirm({ kind: 'run.action', runId, ownerEpoch: before.ownerEpoch, contractVersion: before.contractVersion, action })
          const current = await owned(runId)
          if (current.revision !== before.revision || current.contractVersion !== before.contractVersion || terminal(current.state)) return false
          const grant = await (await authority()).issue({ ...grantBinding(current, action), expiresAt: Date.now() + 60_000 }, { confirmedBy: approval.actorId, confirmationId: `approval_${randomUUID()}` })
          grants.set(`${runId}:${action.id}`, { ...grant, hash: digest(canonical(action)), contractVersion: current.contractVersion, ownerEpoch: current.ownerEpoch })
          return true
        } catch (error) { if (['APPROVAL_REQUIRED', 'scoped_grant_denied'].includes(error.code)) return false; throw error }
      },
      async prepare(intent) {
        const action = validateAction(intent)
        return serialized(runId, async () => {
          let run = await owned(runId)
          const previous = run.actions.find(entry => entry.id === action.id)
          if (previous) {
            if (['kind', 'target', 'parameterHash', 'effect', 'retryPolicy'].some(key => previous[key] !== action[key]) || JSON.stringify(previous.context) !== JSON.stringify(action.context)) fail('ACTION_CONFLICT', '操作编号已绑定其他参数。')
            return { fresh: false, state: previous.state, receipt: previous.receipt }
          }
          try {
            if (action.effect === 'external_write') {
              const grant = grants.get(`${runId}:${action.id}`)
              if (!run.contract.allowedExternalActions.includes(action.kind) || !grant || grant.hash !== digest(canonical(action)) || grant.ownerEpoch !== run.ownerEpoch || grant.contractVersion !== run.contractVersion || grant.expiresAt < Date.now()) fail('APPROVAL_REQUIRED', '外部操作缺少当前版本、参数绑定的宿主授权。')
              if (active.has(runId) || externalLeases.has(runId)) fail('TURN_ACTIVE', '等待当前执行结束后再提交外部交付操作。')
              const lease = await acquireProcessLock(path.join(leaseDirectory, `${digest(runId)}.lock`))
              externalLeases.set(runId, { actionId: action.id, lease })
              if (run.state === 'waiting_input') run = await store.transitionRun({ ...guard(run), state: 'running', reason: 'Host authorized a scoped external delivery action' })
            }
            await store.prepareAction({ ...guard(run), action })
          } catch (error) {
            const held = externalLeases.get(runId)
            if (held?.actionId === action.id) { externalLeases.delete(runId); await held.lease.release() }
            throw error
          }
          if (action.effect === 'external_write') {
            try { await (await authority()).verifyAndConsume(grants.get(`${runId}:${action.id}`).token, grantBinding(await owned(runId), action)) }
            catch (error) {
              try {
                let current = await owned(runId)
                current = await store.settleAction({ ...guard(current), actionId: action.id, state: 'not_applied', receipt: { summary: 'Scoped grant was not consumable; no external effect was started', evidenceRefs: [] } })
                if (current.state === 'running' && !hasUnknown(current)) await store.transitionRun({ ...guard(current), state: 'waiting_input', reason: 'Scoped grant was not consumable; no external operation started' })
              } finally {
                const held = externalLeases.get(runId)
                if (held?.actionId === action.id) { externalLeases.delete(runId); await held.lease.release() }
              }
              throw error
            }
          }
          return { fresh: true, state: 'prepared', receipt: null }
        })
      },
      async settle(input) {
        return serialized(runId, async () => {
          try {
            let run = await owned(runId)
            const proof = await persist(run, { actionId: input.id, state: input.state, receipt: input.receipt || {} }, 'system', input.id)
            run = await owned(runId)
            run = await store.settleAction({ ...guard(run), actionId: input.id, state: input.state, receipt: { summary: input.receipt?.summary || 'Recorded by trusted execution host', evidenceRefs: [...(input.receipt?.evidenceRefs || []), proof.id] } })
            if (!active.has(runId) && ['running', 'outcome_unknown'].includes(run.state) && !hasUnknown(run)) run = await store.transitionRun({ ...guard(run), state: 'waiting_input', reason: 'External operation has a durable receipt; awaiting further delivery or explicit completion' })
            return run
          } finally {
            const held = externalLeases.get(runId)
            if (held?.actionId === input.id) { externalLeases.delete(runId); await held.lease.release() }
          }
        })
      }
    })
  }

  async function reconcile(input) {
    if (active.has(input.runId) || externalLeases.has(input.runId)) fail('ACTION_STILL_RUNNING', '当前操作仍可能在执行，请先停止并等待其收束后再核查。')
    const before = await owned(input.runId)
    const action = before.actions.find(entry => entry.id === input.actionId)
    if (!action || !['prepared', 'unknown'].includes(action.state)) fail('ACTION_FINAL', '该操作没有需要核查的未知结果。')
    if (!['succeeded', 'failed', 'not_applied'].includes(input.state) || !Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length) fail('RECONCILIATION_REQUIRED', '核查必须给出实际证据和明确结果。')
    for (const id of input.evidenceRefs) await artifacts.getMetadata({ actor: scopedActor(before), id })
    await confirm({ kind: 'run.reconcile', runId: before.id, actionId: action.id, state: input.state, evidenceRefs: input.evidenceRefs })
    return serialized(before.id, async () => {
      const current = await owned(before.id)
      if (current.revision !== before.revision) fail('REVISION_CONFLICT', '核查确认期间任务已变化，请重新检查。')
      const reconciled = await store.settleAction({ ...guard(current), actionId: action.id, state: input.state, receipt: { evidenceRefs: input.evidenceRefs, summary: 'Outcome explicitly reconciled by the host' } })
      return reconciled.state === 'outcome_unknown' && !hasUnknown(reconciled)
        ? store.transitionRun({ ...guard(reconciled), state: 'paused', reason: 'Unknown outcomes reconciled; host must explicitly resume' })
        : reconciled
    })
  }

  async function acceptReceipt(runId, receipt) {
    return serialized(runId, async () => {
      let run = await owned(runId)
      if (!active.has(runId)) fail('STALE_TURN', '验收不能脱离当前受控执行提交。')
      const evidence = await persist(run, receipt)
      active.get(runId).verificationEligible = receipt.allPass === true
      run = await store.setCandidate({ ...guard(run), candidateHash: receipt.candidateHash })
      for (const criterion of receipt.criteria || []) {
        if (!run.contract.requiredCriteria.some(required => required.id === criterion.id)) continue
        const status = ['passed', 'failed', 'unknown', 'not_applicable'].includes(criterion.status) ? criterion.status : 'unknown'
        run = await store.recordVerification({ ...guard(run), receipt: { id: `verification_${digest([receipt.id, criterion.id]).slice(0, 40)}`, criterionId: criterion.id, candidateHash: receipt.candidateHash, status, evidenceRefs: [evidence.id] } })
      }
      return run
    })
  }

  async function execute(input) {
    // Keep the exact submitted scope across lock/config/acceptance/artifact waits.
    // Signals and output callbacks remain host capabilities; JSON limits do not.
    input = { ...input, ...(input.limits !== undefined ? { limits: freeze(structuredClone(input.limits)) } : {}) }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) fail('INVALID_INPUT', '任务输入不能为空。')
    if (active.has(input.runId)) fail('TURN_ACTIVE', '该任务已有正在执行的回合。')
    const lease = await acquireProcessLock(path.join(leaseDirectory, `${digest(input.runId)}.lock`))
    const controller = new AbortController()
    let signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    let resolveDone
    const done = new Promise(resolve => { resolveDone = resolve })
    active.set(input.runId, { controller, done })
    let polling = false
    const poll = setInterval(async () => {
      if (!begun || polling || controller.signal.aborted) return
      polling = true
      try {
        const current = await owned(input.runId)
        if (['paused', 'cancelled'].includes(current.state)) controller.abort(runStoreError('RUN_STOP_REQUESTED', '宿主已通过持久控制通道要求停止。'))
      } catch (error) { controller.abort(error) }
      finally { polling = false }
    }, 250)
    poll.unref()
    let turnId, begun = false, verificationRunner
    try {
      let run = await owned(input.runId)
      active.get(input.runId).sessionId = run.binding.sessionId
      if (terminal(run.state) || hasUnknown(run)) fail('UNRESOLVED_ACTIONS', '任务已结束或有未核查操作，不能开始新回合。')
      if (!run.binding.contractApprovalRef) fail('APPROVAL_REQUIRED', '迁移的旧会话需要新建并确认任务契约，不能直接自主执行。')
      const approval = await readJson(run, run.binding.contractApprovalRef)
      if (normalizeRunHostBinding(approval.hostBindingHash ?? null) !== hostBindingHash) fail('HOST_BINDING_CHANGED', '宿主执行配置与原始授权不一致，未重启模型或工具。')
      if (approval.contractHash !== digest(canonical(run.contract))) fail('CONTRACT_CHANGED', '任务契约已变化，原授权不再适用。')
      const workspaceIdentity = await assertTaskWorkspace(run.binding.cwd)
      if (approval.workspaceIdentity && JSON.stringify(workspaceIdentity) !== JSON.stringify(approval.workspaceIdentity)) fail('WORKSPACE_CHANGED', '任务工作树已被替换，原批准范围不再适用。')
      await repairRunHistory({ run, readResult: async artifactId => {
        if (!/^art_[0-9a-f-]{36}$/.test(artifactId)) return null
        const metadata = await artifacts.getMetadata({ actor: scopedActor(run), id: artifactId })
        if (metadata.size > 4 * 1024 * 1024) return null
        const page = await artifacts.read({ actor: scopedActor(run), id: artifactId, limit: 1024 })
        // Plain-text reconciliation evidence is valid but not a serialized tool response.
        if (!Buffer.from(page.data, 'base64').toString('utf8').trimStart().startsWith('{')) return null
        try { return await readJson(run, artifactId) } catch (error) { if (error instanceof SyntaxError) return null; throw error }
      } })
      await executionBackend.ensureReady({ cwd: run.binding.cwd, contract: run.contract, signal })
      const hostContextRefs = [...(run.lastTurn?.hostContextRefs || [])]
      const priorInput = run.lastTurn?.inputArtifactRef ? await readJson(run, run.lastTurn.inputArtifactRef) : null
      let savedBudget = await store.getRunBudget({ runId: run.id })
      if (!savedBudget || savedBudget.budgetUsd <= 0 && !savedBudget.localFreePolicy) fail('TASK_BUDGET_EXHAUSTED', '任务缺少持久预算或模型预算为零且无明确本机免费授权，未发起模型请求。')
      if (savedBudget.localFreePolicy) validateLocalFreeBudget(options.localFreeAuthorization, { budgetUsd: savedBudget.budgetUsd, profiles: savedBudget.profiles, expectedPolicy: savedBudget.localFreePolicy })
      else if (freePolicy) fail('LOCAL_FREE_AUTHORIZATION', '不能把普通费用任务临时改为免费任务。')
      if (savedBudget.requests.some(request => ['reserved', 'unknown'].includes(request.status))) fail('TASK_BUDGET_OUTCOME_UNKNOWN', '先核查原请求或子任务的未结算费用，不能重发并重新花费预算。')
      const limits = input.limits || priorInput?.limits || { budgetUsd: savedBudget.budgetUsd, deadlineAt: savedBudget.deadlineAt }
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !['deadlineAt', 'budgetUsd'].includes(key)) || limits.budgetUsd !== undefined && (!Number.isFinite(limits.budgetUsd) || limits.budgetUsd < 0 || limits.budgetUsd > 1_000_000) || limits.deadlineAt !== undefined && (!Number.isSafeInteger(limits.deadlineAt) || limits.deadlineAt < 1)) fail('INVALID_RUN_LIMITS', '任务期限与预算必须由宿主提供有效的有限值。')
      if (priorInput?.limits?.deadlineAt && (!limits.deadlineAt || limits.deadlineAt > priorInput.limits.deadlineAt) || priorInput?.limits?.budgetUsd !== undefined && (limits.budgetUsd === undefined || limits.budgetUsd > priorInput.limits.budgetUsd)) fail('RUN_LIMITS_EXPANSION', '恢复不能静默延长期限或增加原有预算。')
      if (!Number.isFinite(limits.budgetUsd) || !limits.deadlineAt || limits.budgetUsd > savedBudget.budgetUsd || limits.deadlineAt > savedBudget.deadlineAt) fail('RUN_LIMITS_EXPANSION', '回合不能扩大已确认的持久总预算或期限。')
      if (limits.deadlineAt && Date.now() >= limits.deadlineAt) fail('TASK_DEADLINE', '任务期限已到，不会通过恢复重置。')
      if (limits.budgetUsd === 0 && !savedBudget.localFreePolicy) fail('TASK_BUDGET_EXHAUSTED', '任务模型预算为零，未发起模型请求。')
      if (limits.deadlineAt) signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, limits.deadlineAt - Date.now()))])
      let restoredAcceptance = null
      if (acceptance || hostContextRefs.length) {
        let boundary
        if (hostContextRefs[0]) boundary = await readJson(run, hostContextRefs[0])
        else {
          boundary = await prepareHostAcceptance({ cwd: run.binding.cwd, acceptance, signal })
          hostContextRefs.push((await persist(run, boundary)).id)
        }
        const criterionIds = new Set([...(boundary.goal.criteria || []), ...(boundary.goal.subGoals || []).flatMap(goal => goal.criteria || [])].map(criterion => criterion.id))
        if (run.contract.requiredCriteria.some(criterion => !criterionIds.has(criterion.id))) fail('ACCEPTANCE_CONTRACT_MISMATCH', '独立验收标准没有覆盖已冻结任务契约的全部必需项目。')
        if (input.mode && input.mode !== 'longagent') fail('ACCEPTANCE_MODE_REQUIRED', '具有独立验收的委托使用 Ultra 受控流程。')
        if (typeof executionBackend.createVerificationBackend !== 'function') fail('VERIFICATION_BACKEND_REQUIRED', '独立验收缺少只读来源和独立候选副本后端，拒绝复用实现工作区。')
        verificationRunner = createVerificationRunner({ cwd: run.binding.cwd, signal, createBackend: options => executionBackend.createVerificationBackend(options) })
        restoredAcceptance = await restoreHostAcceptance(boundary, { cwd: run.binding.cwd, signal, onReceipt: receipt => acceptReceipt(run.id, receipt), runCommand: options => verificationRunner.runCommand(options) })
      }
      const mode = input.mode || (restoredAcceptance ? 'longagent' : 'agent')
      const route = mode === 'longagent'
        ? { model: input.model, providerType: input.providerType, baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv }
        : await resolveTaskModel(kernel.configState, { role: options.modelRole || 'implementation', model: input.model, providerType: input.providerType, baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv })
      const approvedScope = budgetRoute(kernel.configState, route)
      if (!savedBudget.profiles?.some(profile => profile.scopeHash === approvedScope.scopeHash)) {
        if (savedBudget.localFreePolicy) fail('LOCAL_FREE_AUTHORIZATION', '本机免费任务不能切换到另一个端点、模型或凭据范围。')
        const profile = await prepareBudgetProfile(kernel.configState, route)
        const profileApproval = await confirm({ kind: 'run.budget_profile', runId: run.id, ownerEpoch: run.ownerEpoch, revision: run.revision, profile })
        const current = await owned(run.id)
        if (current.revision !== run.revision) fail('REVISION_CONFLICT', '价格档案确认期间任务发生变化，未发起请求。')
        savedBudget = await store.approveRunBudgetProfile({ ...guard(current), profile, approval: profileApproval })
        run = await owned(run.id)
      }
      const selectedProvider = route.providerType || kernel.configState.config.provider?.default
      const providerConfig = kernel.configState.config.provider?.[selectedProvider] || {}
      const routeIdentity = { provider: selectedProvider, model: route.model || providerConfig.default_model || '', scopeHash: approvedScope.scopeHash }
      if (run.lastTurn?.inputArtifactRef) {
        const previous = await readJson(run, run.lastTurn.inputArtifactRef)
        if (previous.routeIdentity && digest(canonical(previous.routeIdentity)) !== digest(canonical(routeIdentity))) await confirm({ kind: 'run.model_change', runId: run.id, revision: run.revision, previous: previous.routeIdentity, next: routeIdentity })
      }
      const promptArtifact = await persist(run, { prompt: input.prompt, mode, model: input.model || null, providerType: input.providerType || null, routeIdentity, limits }, 'user')
      turnId = `turn_${randomUUID()}`
      run = await serialized(run.id, async () => {
        let current = await owned(run.id)
        if (current.revision !== run.revision) fail('REVISION_CONFLICT', '准备执行期间任务发生变化，未忽略停止请求或重新开始任务。')
        if (current.state !== 'running') current = await store.transitionRun({ ...guard(current), state: 'running', reason: 'Host explicitly resumed execution' })
        return store.beginTurn({ ...guard(current), turnId, inputHash: digest(input.prompt), inputArtifactRef: promptArtifact.id, hostContextRefs })
      })
      begun = true
      const actions = actionAdapter(run.id)
      const binding = createDurableRunBinding({
        runId: run.id, turnId, ownerId, ownerEpoch: run.ownerEpoch,
        ...(isTaskGraphHost(options.taskGraph) ? { taskGraph: options.taskGraph } : {}),
        artifactAccess: createTaskArtifactAccess({ store: artifacts, resolveActor: async () => scopedActor(await owned(run.id)) }),
        abort: error => controller.abort(error),
        async prepareTool(call) {
          if (!allowedTools().includes(call.tool.name)) fail('TOOL_SCOPE_DENIED', '该工具不属于当前子任务的宿主白名单。')
          const effect = ['read', 'search'].includes(call.capability) || ['read', 'list', 'todowrite'].includes(call.tool.name) ? 'read' : 'local_write'
          const action = { id: `tool_${digest([run.id, turnId, call.sessionId, call.invocationId]).slice(0, 48)}`, kind: `tool.${call.tool.name}`, target: typeof call.args.path === 'string' ? path.resolve(run.binding.cwd, call.args.path) : run.binding.cwd, parameterHash: digest(canonical(call.args)), effect, retryPolicy: effect === 'read' ? 'safe' : 'reconcile', context: { sessionId: call.sessionId, turnId: call.turnId, invocationId: call.invocationId, durableTurnId: turnId } }
          let grant
          if (effect !== 'read') {
            const current = await owned(run.id)
            if (!current.contract.allowedPaths.length) fail('APPROVAL_REQUIRED', '当前任务契约不允许修改工作区。')
            const confirmed = toolConfirmations.get(`${run.id}:${turnId}:${call.tool.name}:${digest(canonical(call.args))}`)
            const confirmationRef = confirmed ? (await persist(current, { approval: confirmed, parameterHash: action.parameterHash, tool: call.tool.name })).id : current.binding.contractApprovalRef
            grant = await (await authority()).issue({ ...grantBinding(current, action), expiresAt: Date.now() + 60_000 }, { confirmedBy: confirmed?.actorId || approval.approval.actorId, confirmationId: confirmationRef })
          }
          const prepared = await actions.prepare(action)
          if (!prepared.fresh) fail('ACTION_UNRESOLVED', '本次工具调用已有记录，未重复执行。')
          if (grant) {
            try { await (await authority()).verifyAndConsume(grant.token, grantBinding(await owned(run.id), action)) }
            catch (error) { await actions.settle({ id: action.id, state: 'not_applied', receipt: { summary: 'Host grant rejected before tool effect' } }); throw error }
          }
          return action
        },
        executeTool: call => executionBackend.executeTool({ ...call, runId: run.id }),
        async settleTool({ operation, result }) {
          const state = result.status === 'cancelled' || result.metadata?.outcomeUnknown === true ? 'unknown' : result.status === 'completed' ? 'succeeded' : 'failed'
          const current = await owned(run.id)
          // Preserve the actual result before publishing a settled receipt.
          const resultArtifact = await persist(current, { actionId: operation.id, result }, 'tool', operation.id)
          await actions.settle({ id: operation.id, state, receipt: { summary: `${operation.kind}: ${result.status}`, evidenceRefs: [resultArtifact.id] } })
          if (state === 'unknown') controller.abort(runStoreError('UNRESOLVED_ACTIONS', '操作结果不明，已停止后续执行并保留核查证据。'))
        },
        async failTool({ operation, error, effectStarted }) {
          const state = !effectStarted || error.operationNotStarted === true ? 'not_applied' : operation.effect === 'read' ? 'failed' : 'unknown'
          await actions.settle({ id: operation.id, state, receipt: { summary: `${operation.kind}: ${error.code || error.name || 'execution_error'}` } })
          if (state === 'unknown') controller.abort(runStoreError('UNRESOLVED_ACTIONS', '副作用可能已经发生，必须核查后才能继续。'))
        }
      })
      const previousActions = run.actions.slice(-20).map(action => ({ id: action.id, kind: action.kind, state: action.state, evidenceRefs: action.receipt?.evidenceRefs || [] }))
      const recoveryNote = previousActions.length ? `\n\n[Persisted task receipts, not a request to repeat operations]\nTask ${run.id}; contract version ${run.contractVersion}. Inspect artifact_read/artifact_search evidence before repeating an operation.\n${JSON.stringify(previousActions)}` : ''
      const budgetMutation = (method, data) => serialized(run.id, async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const current = await owned(run.id)
          try { return await store[method]({ ...guard(current), ...data }) }
          catch (error) { if (error.code !== 'REVISION_CONFLICT' || attempt === 19) throw error }
        }
      })
      const charged = await withRequestBudget({ budgetUsd: limits.budgetUsd, deadlineAt: limits.deadlineAt, alreadySpent: savedBudget.spentUsd, profiles: savedBudget.profiles,
        ...(savedBudget.localFreePolicy ? { localFreeAuthorization: options.localFreeAuthorization, localFreeUsage: { usedRequests: savedBudget.usedRequests, reservedTokens: savedBudget.reservedTokens } } : {}),
        durable: {
          async reserve(request) {
            const receipt = await budgetMutation('reserveModelBudget', { ...request, kind: 'model' })
            if (receipt?.fresh !== true) fail('TASK_BUDGET_REQUEST_REPLAY', '该请求 ID 已有持久费用预留，未重复发起推理。')
            return receipt
          },
          settle: ({ requestId, amountUsd, status }) => budgetMutation('settleModelBudget', { requestId, amountUsd, status })
        } }, () => withDurableRun(binding, () => kernel.executeTurn({
        prompt: input.prompt + recoveryNote, sessionId: run.binding.sessionId, mode,
        ...(route.model ? { model: route.model } : {}), ...(route.providerType ? { providerType: route.providerType } : {}),
        ...(route.baseUrl !== undefined ? { baseUrl: route.baseUrl } : {}), ...(route.apiKeyEnv !== undefined ? { apiKeyEnv: route.apiKeyEnv } : {}),
        signal, output: input.output, acceptance: restoredAcceptance,
        runSpec: createRunSpec({ runId: run.id, sessionId: run.binding.sessionId, limits, role: { name: 'durable-delegate', tools: allowedTools(), prompt: `The trusted host froze this task contract. Do not silently revise its objective, exclusions or acceptance criteria. Completion is decided by independent verification, not your final prose.\n${JSON.stringify(run.contract)}` }, workspace: { root: run.binding.cwd, cwd: run.binding.cwd, isolation: 'strict', writeScope: run.contract.allowedPaths.length ? 'contract' : 'read-only' } })
      })))
      const result = charged.result
      await flushNow()
      let current = await owned(run.id)
      const resultArtifact = await persist(current, result)
      current = await serialized(run.id, async () => store.endTurn({ ...guard(await owned(run.id)), turnId, state: signal.aborted ? 'paused' : result.error || result.budgetExceeded ? 'verification_failed' : 'waiting_input', resultArtifactRef: resultArtifact.id }))
      const verified = Boolean(restoredAcceptance && active.get(run.id)?.verificationEligible === true && result.longagent?.status === 'completed')
      if (restoredAcceptance && current.state === 'waiting_input' && !verified) {
        current = await store.transitionRun({ ...guard(current), state: 'verification_failed', reason: 'Final controlled acceptance did not declare the unchanged candidate complete' })
      }
      return { run: current, turn: result, verified, awaitingDelivery: verified, budget: await store.getRunBudget({ runId: run.id }) }
    } catch (error) {
      if (begun) {
        try {
          await serialized(input.runId, async () => {
            const current = await owned(input.runId)
            if (current.lastTurn?.id === turnId && current.lastTurn.status === 'running') await store.endTurn({ ...guard(current), turnId, state: signal.aborted ? 'paused' : 'verification_failed', reason: String(error.code || error.name || 'execution_failed') })
          })
        } catch (stateError) { if (!['STALE_OWNER', 'STORE_CLOSED', 'STORE_OUTCOME_UNKNOWN'].includes(stateError.code)) throw stateError }
      }
      throw error
    } finally {
      clearInterval(poll)
      active.delete(input.runId)
      try { await verificationRunner?.dispose() } finally { try { await lease.release() } finally { resolveDone() } }
    }
  }

  async function recordDeliveryReceipt(input) {
    const { runId, criterionId, inspectDelivery } = input
    if (typeof inspectDelivery !== 'function' || typeof options.verifyDeliveryBinding !== 'function') fail('DELIVERY_VERIFIER_REQUIRED', '外部交付验收必须由宿主提供实际平台查询与已封存候选映射核验。')
    const before = await owned(runId)
    if (active.has(before.id) || !before.candidateHash) fail('VERIFICATION_REQUIRED', '先结束任务并封存候选，再核验外部交付。')
    const receipt = freeze(structuredClone(await inspectDelivery()))
    if (!receipt || receipt.runId !== before.id || !receipt.repositoryId || !/^[a-f0-9]{40,64}$/.test(receipt.candidateSha || '') || !/^[a-f0-9]{40,64}$/.test(receipt.targetSha || '') || await options.verifyDeliveryBinding({ run: freeze(structuredClone(before)), receipt }) !== true) fail('DELIVERY_BINDING_MISMATCH', '平台回执未绑定当前已验收候选、仓库或分支版本。')
    return serialized(before.id, async () => {
      let current = await owned(before.id)
      if (current.revision !== before.revision) fail('REVISION_CONFLICT', '外部核验期间本地候选或任务状态已变化。')
      const proof = await persist(current, receipt)
      current = await owned(before.id)
      if (current.revision !== before.revision) fail('REVISION_CONFLICT', '外部回执保存期间候选或任务状态已变化，未把旧证明附加到新候选。')
      return store.recordVerification({ ...guard(current), receipt: { id: `delivery_${randomUUID()}`, criterionId, candidateHash: current.candidateHash, status: receipt.status === 'mergeable' ? 'passed' : 'unknown', evidenceRefs: [proof.id] } })
    })
  }

  async function verifiedCandidate(input) {
    const before = await owned(input.runId)
    if (active.has(before.id) || before.lastTurn?.status === 'running') fail('TURN_ACTIVE', '运行中的任务不能标记为完成。')
    const unresolved = before.actions.filter(action => ['prepared', 'unknown'].includes(action.state))
    const reconciliation = input.reconcileActionId && unresolved.length === 1 && unresolved[0].id === input.reconcileActionId
      && unresolved[0].effect === 'external_write' && unresolved[0].kind.startsWith('forge.') && !externalLeases.has(before.id)
    const prepared = input.preparedActionId && unresolved.length === 1 && unresolved[0].id === input.preparedActionId
      && unresolved[0].state === 'prepared' && unresolved[0].effect === 'external_write' && unresolved[0].kind.startsWith('forge.')
      && externalLeases.get(before.id)?.actionId === input.preparedActionId
    if (unresolved.length && !reconciliation && !prepared || !before.candidateHash || !before.lastTurn?.resultArtifactRef || !before.lastTurn.hostContextRefs?.length) fail('VERIFICATION_REQUIRED', '缺少独立验收或仍有未知操作，不能标记完成。')
    const result = await readJson(before, before.lastTurn.resultArtifactRef)
    if (result.longagent?.status !== 'completed' || result.error || result.budgetExceeded) fail('VERIFICATION_REQUIRED', '最终受控验收未成功，模型的完成文字不能代替验收。')
    const boundary = await readJson(before, before.lastTurn.hostContextRefs[0])
    const refs = new Set(before.verifications.filter(receipt => receipt.candidateHash === before.candidateHash
      && receipt.candidateGeneration === before.candidateGeneration && receipt.contractVersion === before.contractVersion).flatMap(receipt => receipt.evidenceRefs))
    let verifiedReceipt = null
    for (const ref of refs) {
      const proof = await readJson(before, ref)
      if (proof.schema === 'kk.verification-receipt.v1' && proof.boundaryId === boundary.id
        && proof.baseRevision === boundary.baseRevision && proof.candidateHash === before.candidateHash
        && proof.candidate?.treeFingerprint === before.candidateHash && proof.allPass === true) verifiedReceipt = proof
    }
    if (!verifiedReceipt) fail('VERIFICATION_REQUIRED', '缺少绑定原始验收边界和当前候选的真实全绿回执。')
    const candidate = await captureAcceptanceCandidate(before.binding.cwd)
    if (candidate.treeFingerprint !== before.candidateHash || candidate.head !== verifiedReceipt.candidate.head) fail('STALE_CANDIDATE', '验收后工作区内容或 Git 历史发生变化，请重新验收。')
    const after = await owned(before.id)
    if (after.revision !== before.revision) fail('REVISION_CONFLICT', '候选核查期间任务已经变化。')
    return { run: after, candidate }
  }

  async function complete(input) {
    const { run: before } = await verifiedCandidate({ runId: input.runId })
    await confirm({ kind: 'run.complete', runId: before.id, candidateHash: before.candidateHash, contractVersion: before.contractVersion })
    return serialized(before.id, async () => {
      const current = await owned(before.id)
      if (current.revision !== before.revision) fail('REVISION_CONFLICT', '完成确认期间任务已经变化。')
      const verified = await verifiedCandidate({ runId: current.id })
      if (verified.run.revision !== current.revision) fail('REVISION_CONFLICT', '最终候选核查期间任务已经变化。')
      return store.transitionRun({ ...guard(current), state: 'completed', reason: 'Host accepted independently verified task delivery' })
    })
  }

  async function resumeDelivery(input) {
    const { run: before } = await verifiedCandidate({ runId: input.runId })
    if (input.expectedRevision !== undefined && input.expectedRevision !== before.revision) fail('REVISION_CONFLICT', '交付恢复依据的任务版本已变化。')
    if (before.state === 'waiting_input') return before
    if (before.state !== 'paused') fail('RUN_NOT_PAUSED', '只有明确暂停且已独立验收的任务可以恢复交付；不会启动模型或绕过未知结果。')
    await confirm({ kind: 'run.delivery', runId: before.id, revision: before.revision, ownerEpoch: before.ownerEpoch,
      candidateHash: before.candidateHash, contractVersion: before.contractVersion })
    return serialized(before.id, async () => {
      const { run: current } = await verifiedCandidate({ runId: before.id })
      if (current.revision !== before.revision) fail('REVISION_CONFLICT', '交付恢复确认期间任务已经变化。')
      return store.transitionRun({ ...guard(current), state: 'waiting_input', reason: 'Host explicitly resumed verified delivery only; no model request or budget reset' })
    })
  }

  return Object.freeze({
    start, attach, execute, inspect, reconcile, actionAdapter, recordDeliveryReceipt, verifiedCandidate, resumeDelivery, complete,
    pause: input => stop(input, 'paused'), cancel: input => stop(input, 'cancelled'),
    async resume(input) {
      if (!ownership.has(input.runId)) await attach(input)
      const run = await owned(input.runId)
      const previous = input.prompt ? null : run.lastTurn?.inputArtifactRef ? await readJson(run, run.lastTurn.inputArtifactRef) : null
      return execute({ ...previous, ...input, prompt: input.prompt || previous?.prompt || run.contract.objective })
    },
    async close() {
      if (externalLeases.size) fail('RUN_BUSY_EXTERNAL', '外部操作尚未记录结果，等待其完成或核查后再关闭协调器。')
      const pendingTurns = [...active.values()].map(turn => turn.done)
      for (const [runId] of active) await stop({ runId, reason: 'Coordinator shutdown' }, 'paused')
      await Promise.allSettled(pendingTurns)
      await Promise.allSettled([...queues.values()])
      closed = true
      unsubscribe()
      kernel.prompts.permission.setPermissionPromptInterceptor(null)
    }
  })
}

/**
 * Fail closed on unreadable ledgers; cancellation does not erase unknown effects.
 * @param {string} sessionId
 * @param {{store?: {listRuns: Function, getRun: Function, close: Function}, directory?: string}} [options]
 */
export async function hasUnresolvedSessionRun(sessionId, options = {}) {
  let store = options.store
  let own = false
  if (!store) {
    const directory = options.directory || path.join(userRootDir(), 'run-store')
    try { await access(path.join(directory, 'runs.sqlite')) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    store = await openRunStore({ directory, readOnly: true }); own = true
  }
  try {
    const summaries = await store.listRuns({ limit: 500 })
    if (summaries.length === 500) return true // No unsafe pruning when listing may be incomplete.
    for (const summary of summaries) {
      const run = await store.getRun(summary.id)
      if (run.binding?.sessionId === sessionId && (!terminal(run.state) || hasUnknown(run))) return true
    }
    return false
  } finally { if (own) await store.close() }
}
