import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { loadConfig } from '../config/load-config.mjs'
import { createRunCoordinator, createDelegatedKernel, createDockerExecutionBackend, inspectStrictIsolation, createTaskWorkspace, taskWorkspaceBaseline, currentArtifactAccountId, checkWorkspaceTrust, verifyRunHostBinding } from '../kernel/index.mjs'
import { openRunStore, createArtifactStore } from '../sdk/storage.mjs'
import { addRunForgeCommands } from './run-forge.mjs'
import { validateTaskGraphHostConfig, graphHostFromMetadata, confirmGraphActionInTerminal } from './run-graph.mjs'
import { inspectRunEnvironment, restoreRunEnvironment } from './environments.mjs'
import { prepareNpmWorkspace } from '../sdk/environments.mjs'
import { runHostBindingHash } from './run-host-binding.mjs'
import { readBoundedJsonInput } from './bounded-input.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const reject = message => { throw new Error(message) }
const runId = id => { if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) reject('任务ID无效。'); return id }
const metaFile = id => path.join(userRootDir(), 'run-hosts', `${runId(id)}.json`)

async function contractFile(file) {
  const parsed = await readBoundedJsonInput(file, { label: '任务契约文件' })
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !['contract', 'acceptance', 'taskGraph', 'limits'].includes(key)) ||
      !parsed.contract?.objective || !Array.isArray(parsed.contract.requiredCriteria) || !parsed.contract.requiredCriteria.length ||
      parsed.acceptance?.required !== true || !parsed.acceptance.goal || !parsed.acceptance.testSources?.length) reject('任务文件必须包含contract及required:true的acceptance（目标、非空验收条件和测试来源）。')
  if (!Array.isArray(parsed.contract.allowedPaths) || parsed.contract.allowedPaths.length && (parsed.contract.allowedPaths.length !== 1 || parsed.contract.allowedPaths[0] !== '.')) reject('严格执行的allowedPaths目前只接受[]只读或["."]整个独立任务副本；不会默默扩大其他路径授权。')
  const limits = parsed.limits
  if (!limits || typeof limits !== 'object' || Object.keys(limits).some(key => !['budgetUsd', 'deadlineAt'].includes(key)) || !Number.isFinite(limits.budgetUsd) || limits.budgetUsd < 0 || limits.budgetUsd > 1_000_000 || !Number.isSafeInteger(limits.deadlineAt) || limits.deadlineAt <= Date.now() || limits.deadlineAt - Date.now() > 7 * 86400000) reject('新任务必须在 limits 中明确 budgetUsd 与未来七天内绝对毫秒 deadlineAt；预算零只允许准备，不发送模型请求。')
  const graph = validateTaskGraphHostConfig(parsed.taskGraph)
  if (graph && (!parsed.contract.allowedTools?.some(tool => ['task', 'task_group'].includes(tool)) || graph.deadlineAt <= Date.now() || graph.deadlineAt - Date.now() > 7 * 86400000)) reject('启用任务图须在父合同明确允许 task/task_group，并指定未来七天内的固定期限。')
  if (graph && (graph.budgetUsd > limits.budgetUsd || graph.deadlineAt > limits.deadlineAt)) reject('任务图预算／期限不能超过父任务 limits 上限。')
  return parsed
}

function printPlan(plan, confirmation, json) {
  if (json) console.log(JSON.stringify({ prepared: false, confirmation, plan }))
  else {
    console.log(`尚未执行。目标：${safe(plan.objective)}\n源仓库：${safe(plan.sourceCwd)}\n固定提交：${plan.baseRevision}\n隔离镜像：${safe(plan.image)}\n验收条件：${plan.criteriaCount}`)
    console.log(`写入范围：${safe(JSON.stringify(plan.allowedPaths))}\n合同明确允许的工具：${safe(JSON.stringify(plan.allowedTools))}\n受控网络目标：${safe(JSON.stringify(plan.allowedNetworkOrigins))}\n外部操作声明（仍需单独授权）：${safe(JSON.stringify(plan.allowedExternalActions))}`)
    if (plan.taskGraph) console.log(`任务图宿主上限：${safe(JSON.stringify(plan.taskGraph))}。子任务及结果仍分别确认，不是一键全部允许。`)
    console.log(`父任务持久预算／期限：${safe(JSON.stringify(plan.limits))}（包含委派预留，缺失用量或未知收费停止后续请求）。`)
    console.log(`当前账号：${safe(plan.actor.accountId)}（切换账号后需要重新确认）。`)
    if (plan.dependencyEnvironment) console.log(`只读依赖环境：${safe(plan.dependencyEnvironment.id)}\n依赖树：${plan.dependencyEnvironment.treeHash}（任务、子任务与独立验收共用；清单变化须重新准备和确认）。`)
    console.log('将从固定提交创建独立工作副本，不复制未提交变更、不修改原工作区。确认后允许在合同范围内自主读写与执行；容器默认断网，外部推送/发布不在此次授权内。')
    console.log(`核对后重复命令并加 --confirm ${confirmation}`)
  }
}

async function hostFor(meta, options, directory, allowedKinds) {
  const accountId = await currentArtifactAccountId()
  if (meta.actor.accountId !== accountId) reject('任务属于另一个设备账号，不能在当前账号下恢复。')
  if (meta.runId) {
    const reader = await openRunStore({ directory, readOnly: true })
    try {
      const run = await reader.getRun(meta.runId)
      if (run.binding.accountId !== accountId || run.binding.projectId !== meta.actor.projectId || path.resolve(run.binding.cwd) !== path.resolve(meta.workspace)) reject('任务宿主资料与原始账号、项目或独立工作区不一致。')
      await verifyRunHostBinding({ run, artifacts: createArtifactStore(), hostBindingHash: runHostBindingHash(meta) })
    } finally { await reader.close() }
  }
  const configState = await loadConfig(meta.sourceCwd)
  const trustState = await checkWorkspaceTrust({ cwd: meta.sourceCwd, cliTrust: Boolean(options.trust), isTTY: Boolean(process.stdin.isTTY) })
  const dependencyEnvironment = await restoreRunEnvironment(meta.dependencyEnvironment, { cwd: meta.workspace, image: meta.image })
  if (dependencyEnvironment) await prepareNpmWorkspace({ environment: dependencyEnvironment, cwd: meta.workspace, image: meta.image })
  // Contract-backed approval is handled by the coordinator, after hard policy
  // checks. Do not replace the user's readonly/deny policy with Yolo here.
  const kernel = await createDelegatedKernel({ cwd: meta.workspace, configState, trustState, dependencyEnvironment, handlers: {
    onEvent(event) { if (['turn.start', 'turn.finish', 'tool.start', 'tool.completed'].includes(event.type)) process.stderr.write(`[${safe(event.type)}] ${safe(event.payload?.tool || '')}\n`) },
    onPermissionPrompt: () => 'deny', onQuestionPrompt: () => ({})
  } })
  let store, taskGraph
  try {
    store = await openRunStore({ directory })
    const artifacts = createArtifactStore()
    taskGraph = graphHostFromMetadata({ meta, store, artifacts, configState, trustState, dependencyEnvironment })
    const coordinator = createRunCoordinator({ kernel, store, artifacts, actor: meta.actor, acceptance: meta.acceptance, hostBindingHash: runHostBindingHash(meta), ...(taskGraph ? { taskGraph } : {}),
      executionBackend: createDockerExecutionBackend({ image: meta.image, networkOrigins: meta.networkOrigins || [], delegationEnabled: Boolean(taskGraph), dependencyEnvironment }),
      authorize: request => {
        if (request.kind === 'run.budget_profile') return confirmGraphActionInTerminal(request)
        if (!allowedKinds.has(request.kind)) return false
        if (request.kind === 'run.takeover' && (!meta.observed || request.runId !== meta.runId || request.revision !== meta.observed.revision || request.previousOwnerEpoch !== meta.observed.ownerEpoch || request.previousOwnerId !== meta.observed.ownerId)) return false
        if (request.kind === 'run.complete' && request.candidateHash !== meta.observed?.candidateHash) return false
        return { actorId: 'local_cli', reason: `Explicit CLI confirmation ${meta.confirmation}` }
      } })
    return { coordinator, async close() { try { await taskGraph?.close(); await coordinator.close() } finally { try { await kernel.shutdown() } finally { await store.close() } } } }
  } catch (error) { await taskGraph?.close(); await kernel.shutdown(); await store?.close(); throw error }
}

function summary(result, json) {
  const run = result.run || result
  const value = { runId: run.id, sessionId: run.binding.sessionId, state: run.state, workspace: run.binding.cwd, candidateHash: run.candidateHash,
    verified: result.verified === true, awaitingDelivery: result.awaitingDelivery === true, settling: run.lastTurn?.status === 'running' && ['paused', 'cancelled'].includes(run.state) }
  if (json) console.log(JSON.stringify(value))
  else console.log(`任务 ${run.id}\n状态：${run.state}${value.awaitingDelivery ? '（本地验收通过，等待交付确认）' : ''}${value.settling ? '（停止请求已记录，执行进程正在收束；未知操作需核查）' : ''}\n工作副本：${safe(run.binding.cwd)}\n会话：${run.binding.sessionId}\n原工作区未修改，未自动合并/推送/发布。`)
}

export function addRunExecutionCommands(command) {
  addRunForgeCommands(command, { hostFor, metaFile })
  command.command('start').description('确认任务契约后，在独立工作树与严格Docker隔离中运行')
    .requiredOption('--contract <file>', '包含contract/acceptance的JSON文件')
    .requiredOption('--image <digest>', '宿主明确批准、本机已有的不可变Docker镜像')
    .option('--cwd <path>', '源Git仓库根目录', process.cwd())
    .option('--environment <directory>', '已批准且 ready 的私有离线依赖环境，不自动安装')
    .option('--environment-store <directory>', '该依赖环境所属的私有环境库')
    .option('--confirm <sha256>', '确认本次具体目标、Git基线、镜像与验收定义')
    .option('--prepare-only', '确认后只创建任务和工作树，不调用模型')
    .option('--trust', '明确允许使用源项目的模型配置；不授予文件或外部操作权限')
    .option('--json', '输出结构化任务结果')
    .action(async (options, child) => {
      const document = await contractFile(options.contract), baseline = await taskWorkspaceBaseline(options.cwd)
      const dependencyEnvironment = await inspectRunEnvironment(options, baseline.cwd)
      const actor = { accountId: await currentArtifactAccountId(), projectId: `project_${digest(baseline.cwd)}` }
      const plan = { sourceCwd: baseline.cwd, baseRevision: baseline.commit, image: options.image, objective: document.contract.objective, criteriaCount: document.contract.requiredCriteria.length,
        allowedPaths: document.contract.allowedPaths, allowedTools: document.contract.allowedTools || [], allowedNetworkOrigins: document.contract.allowedNetworkOrigins || [], allowedExternalActions: document.contract.allowedExternalActions || [], taskGraph: document.taskGraph || null, limits: document.limits, dependencyEnvironment, actor, definition: document }
      const confirmation = digest(plan)
      if (options.confirm !== confirmation) { printPlan({ ...plan, definition: undefined }, confirmation, options.json); return }
      await inspectStrictIsolation({ image: options.image })
      const workspace = await createTaskWorkspace({ cwd: baseline.cwd, expectedCommit: baseline.commit })
      const meta = { schema: 'kk.run-host.v1', sourceCwd: baseline.cwd, workspace: workspace.cwd, baseRevision: baseline.commit, image: options.image,
        acceptance: { ...document.acceptance, baseRevision: baseline.commit }, confirmation, networkOrigins: document.contract.allowedNetworkOrigins || [], taskGraph: document.taskGraph || null, limits: document.limits, dependencyEnvironment,
        actor }
      const directory = child.optsWithGlobals().directory || path.join(userRootDir(), 'run-store')
      const host = await hostFor(meta, options, directory, new Set(['run.contract']))
      let run, stop
      try {
        run = await host.coordinator.start({ contract: document.contract, limits: document.limits })
        await mkdir(path.dirname(metaFile(run.id)), { recursive: true, mode: 0o700 })
        await writePrivateFile(metaFile(run.id), JSON.stringify({ ...meta, runId: run.id }))
        stop = () => { void host.coordinator.pause({ runId: run.id }).catch(() => {}) }
        process.once('SIGINT', stop); process.once('SIGTERM', stop)
        if (options.prepareOnly) summary(run, options.json)
        else summary(await host.coordinator.execute({ runId: run.id, prompt: document.contract.objective, mode: 'longagent' }), options.json)
      } finally { if (stop) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) } await host.close() }
    })
  for (const action of ['resume', 'pause', 'cancel', 'complete']) {
    command.command(`${action} <id>`).description({ resume: '检查持久状态并明确接管任务；未知副作用不重放', pause: '请求当前执行进程暂停，不抢占所有权', cancel: '取消任务并保留工作副本及未决证据', complete: '复核当前候选与全部验收后确认交付完成' }[action])
      .option('--confirm <sha256>', '确认当前任务版本及所有者代次')
      .option('--trust', '明确允许使用源项目模型配置')
      .option('--json', '输出结构化任务结果')
      .action(async (id, options, child) => {
        const stopping = ['pause', 'cancel'].includes(action)
        let meta
        if (!stopping) {
          try { meta = await readBoundedJsonInput(metaFile(id), { label: '任务宿主恢复资料' }) } catch { reject('缺少或无法安全读取该任务的宿主恢复资料。请先查看账本，不要重新执行未知操作。') }
          if (meta.schema !== 'kk.run-host.v1' || meta.runId !== id || !meta.actor || !meta.acceptance || !meta.workspace || !meta.sourceCwd) reject('任务宿主资料损坏，未接管或执行。')
        }
        const directory = child.optsWithGlobals().directory || path.join(userRootDir(), 'run-store')
        const reader = await openRunStore({ directory, readOnly: true })
        let before
        try { before = await reader.getRun(id) } finally { await reader.close() }
        if (stopping) meta = { runId: id, actor: before.binding || {}, image: null }
        const confirmation = digest({ action, runId: id, ...(!stopping ? { revision: before.revision, candidateHash: before.candidateHash, hostBindingHash: runHostBindingHash(meta) } : {}), ownerEpoch: before.ownerEpoch, ownerId: before.ownerId, image: meta.image })
        if (options.confirm !== confirmation) { console.log(options.json ? JSON.stringify({ action, runId: id, state: before.state, confirmation }) : `任务 ${id} 当前状态 ${before.state}，核对后加 --confirm ${confirmation}。`); return }
        meta.confirmation = confirmation
        meta.observed = { revision: before.revision, ownerEpoch: before.ownerEpoch, ownerId: before.ownerId, candidateHash: before.candidateHash }
        if (stopping) {
          const accountId = await currentArtifactAccountId()
          if (before.binding?.accountId !== accountId || before.binding?.projectId !== meta.actor.projectId) reject('任务不属于当前账号和项目，未发送控制请求。')
          const writer = await openRunStore({ directory }), requestId = `control_${randomUUID()}`
          try {
            for (let attempt = 0; attempt < 3; attempt++) {
              const current = await writer.getRun(id)
              if (current.ownerEpoch !== before.ownerEpoch || current.ownerId !== before.ownerId) reject('任务已被新执行者接管，请重新确认。')
              try {
                summary(await writer.requestControl({ runId: id, expectedRevision: current.revision, expectedOwnerId: current.ownerId, expectedOwnerEpoch: current.ownerEpoch, kind: action, requestId, approval: { approved: true, actorId: 'local_cli', reason: `Explicit CLI confirmation ${confirmation}` } }), options.json)
                return
              } catch (error) { if (error.code !== 'REVISION_CONFLICT' || attempt === 2) throw error }
            }
          } finally { await writer.close() }
          return
        }
        const host = await hostFor(meta, options, directory, new Set(['run.takeover', `run.${action}`]))
        try {
          await host.coordinator.attach({ runId: id, expectedRevision: before.revision })
          summary(action === 'resume' ? await host.coordinator.resume({ runId: id }) : await host.coordinator[action]({ runId: id }), options.json)
        } finally { await host.close() }
      })
  }
}
