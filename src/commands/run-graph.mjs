import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { userRootDir } from '../storage/paths.mjs'
import { acquireProcessLock } from '../storage/process-lock.mjs'
import { loadConfig } from '../config/load-config.mjs'
import { openRunStore } from '../storage/run-store.mjs'
import { createArtifactStore } from '../storage/artifact-store.mjs'
import { currentArtifactAccountId, checkWorkspaceTrust, createTaskGraphHost, captureAcceptanceCandidate, verifyRunHostBinding } from '../kernel/index.mjs'
import { restoreRunEnvironment } from './environments.mjs'
import { runHostBindingHash } from './run-host-binding.mjs'
import { readBoundedJsonInput } from './bounded-input.mjs'

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const fail = message => { throw new Error(message) }
const validId = value => { if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) fail('任务 ID 无效。'); return value }

export function validateTaskGraphHostConfig(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['budgetUsd', 'deadlineAt', 'maxConcurrency'].includes(key))
    || !Number.isFinite(value.budgetUsd) || value.budgetUsd <= 0 || value.budgetUsd > 1_000_000
    || !Number.isSafeInteger(value.deadlineAt) || !Number.isSafeInteger(value.maxConcurrency) || value.maxConcurrency < 1 || value.maxConcurrency > 8) fail('taskGraph 必须明确给出正数 budgetUsd、绝对毫秒 deadlineAt 和 1–8 的 maxConcurrency。')
  return { budgetUsd: value.budgetUsd, deadlineAt: value.deadlineAt, maxConcurrency: value.maxConcurrency }
}

let prompts = Promise.resolve()
/** Each exact request gets its own terminal confirmation. Never --yes or a
 * blanket group approval; non-interactive hosts must provide another real UI. */
/** @param {any} request @param {{signal?:AbortSignal}} [control] */
export function confirmGraphActionInTerminal(request, { signal } = {}) {
  const operation = prompts.catch(() => {}).then(async () => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return false
    const confirmation = digest(request).slice(0, 16)
    signal?.throwIfAborted()
    process.stderr.write(`\n委派确认：${safe(request.kind)}\n${safe(JSON.stringify(request))}\n`)
    const terminal = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await terminal.question(`核对本次子任务／动作，输入 ${confirmation} 才同意（其他输入拒绝）：`, { signal })
      return answer.trim() === confirmation ? { actorId: 'local_cli', reason: `Exact interactive graph confirmation ${confirmation}` } : false
    } finally { terminal.close() }
  })
  prompts = operation.catch(() => {}); return operation
}

export function graphHostFromMetadata({ meta, store, artifacts, configState, trustState, dependencyEnvironment = null, authorize = confirmGraphActionInTerminal }) {
  const config = validateTaskGraphHostConfig(meta.taskGraph)
  if (!config) return null
  if (meta.dependencyEnvironment && !dependencyEnvironment) fail('任务图缺少经宿主恢复校验的依赖环境。')
  return createTaskGraphHost({ store, artifacts, actor: meta.actor, configState, trustState, image: meta.image, authorize, dependencyEnvironment,
    maxBudgetUsd: config.budgetUsd, deadlineAt: config.deadlineAt, maxConcurrency: config.maxConcurrency })
}

async function metadata(runId) {
  const meta = await readBoundedJsonInput(path.join(userRootDir(), 'run-hosts', `${validId(runId)}.json`), { label: '任务宿主资料' })
  if (meta.schema !== 'kk.run-host.v1' || meta.runId !== runId || !meta.actor || !meta.workspace || !meta.sourceCwd || !validateTaskGraphHostConfig(meta.taskGraph)) fail('该任务未明确启用有界任务图。')
  if (meta.actor.accountId !== await currentArtifactAccountId()) fail('任务图属于另一个设备账号。')
  return meta
}

function render(graphs, json) {
  if (json) { console.log(JSON.stringify(graphs, null, 2)); return }
  for (const graph of graphs) {
    console.log(`${safe(graph.id)}  ${safe(graph.status)}  revision=${graph.revision}  期限=${new Date(graph.deadlineAt).toISOString()}  预算=$${graph.budgetUsd}`)
    for (const node of graph.nodes) console.log(`  ${safe(node.id)}  ${safe(node.state)}  ${node.role === 'writer' ? '隔离写入' : '只读评审'}  $${node.costUsd}/${node.budgetUsd}\n    候选=${node.candidateHash || '无'}  依赖=${node.dependsOn.join(',') || '无'}\n    父任务可读结果=${node.parentResultRef || '无'}\n    子任务原始证据=${node.evidenceRefs.join(',') || '无'}`)
  }
}

export function addRunGraphCommands(command) {
  const group = command.command('graph').description('查看、逐项核准和恢复持久多代理任务图')
  group.command('inspect <runId> [graphId]').option('--json', '输出完整候选、子任务和证据引用').action(async (runId, graphId, options, child) => {
    const store = await openRunStore({ directory: child.optsWithGlobals().directory || path.join(userRootDir(), 'run-store'), readOnly: true })
    try {
      const run = await store.getRun(validId(runId))
      if (run.binding?.accountId !== await currentArtifactAccountId()) fail('任务图属于另一个设备账号。')
      const graphs = graphId ? [await store.getTaskGraph({ runId, graphId: validId(graphId) })].filter(Boolean) : await store.listTaskGraphs({ runId })
      render(graphs, options.json)
    } finally { await store.close() }
  })
  for (const action of ['approve', 'execute', 'recover', 'cancel']) {
    const entry = group.command(`${action} <runId> <graphId>${action === 'approve' ? ' <nodeId>' : ''}`)
      .description({ approve: '绑定当前候选和证据，逐个核准子任务结果', execute: '运行当前依赖已核准的待执行节点，不重建旧子任务', recover: '只检查持久旧子任务，不自动重放未知副作用', cancel: '取消并保留工作树；未知结果仍需核查' }[action])
      .option('--confirm <sha256>', '确认显示的精确 owner/图版本/候选/证据')
      .option('--trust', '明确允许使用源项目模型配置，不放宽工具合同')
      .option('--json', '输出结构化结果')
    entry.action(async (...args) => {
      const [runId, graphId] = args, nodeId = action === 'approve' ? args[2] : null, options = args.at(-2), child = args.at(-1)
      validId(runId); validId(graphId); if (nodeId) validId(nodeId)
      // Cancellation is a ledger-only stop request. It must remain possible
      // when the original image, dependency cache or host metadata is damaged.
      const meta = action === 'cancel' ? null : await metadata(runId), directory = child.optsWithGlobals().directory || path.join(userRootDir(), 'run-store')
      const reader = await openRunStore({ directory, readOnly: true })
      let before, graph
      try { before = await reader.getRun(runId); graph = await reader.getTaskGraph({ runId, graphId }) } finally { await reader.close() }
      if (!graph || before.binding?.accountId !== await currentArtifactAccountId()) fail('任务图不属于当前账号。')
      if (meta && (before.binding?.accountId !== meta.actor.accountId || before.binding?.projectId !== meta.actor.projectId || path.resolve(before.binding.cwd) !== path.resolve(meta.workspace))) fail('任务图范围与宿主资料不匹配。')
      const node = nodeId ? graph.nodes.find(value => value.id === nodeId) : null
      if (nodeId && !node) fail('逻辑子任务不存在。')
      const currentCandidate = node?.workspace ? (await captureAcceptanceCandidate(node.workspace)).treeFingerprint : null
      const bound = { action, runId, graphId, nodeId, ownerId: before.ownerId, ownerEpoch: before.ownerEpoch, ...(action !== 'cancel' ? { runRevision: before.revision } : {}),
        graphRevision: graph.revision, parentCandidateHash: graph.parentCandidateHash, candidateHash: node?.candidateHash || null, currentCandidate,
        evidenceRefs: node?.evidenceRefs || [], parentResultRef: node?.parentResultRef || null, budgetUsd: graph.budgetUsd, deadlineAt: graph.deadlineAt,
        ...(meta ? { hostBindingHash: runHostBindingHash(meta) } : {}) }
      const confirmation = digest(bound)
      if (options.confirm !== confirmation) {
        console.log(options.json ? JSON.stringify({ prepared: false, confirmation, ...bound }) : `尚未执行 ${action}。\n${safe(JSON.stringify(bound))}\n请先通过 runs graph inspect 查看完整信息和产物证据，再重复命令加 --confirm ${confirmation}`)
        return
      }
      // A running coordinator holds the execution lease until it drains. A
      // stop request must use ledger CAS without waiting behind that lease.
      const lease = action === 'cancel' ? null : await acquireProcessLock(path.join(userRootDir(), 'run-execution-locks', `${digest(runId)}.lock`))
      let store, host
      try {
        store = await openRunStore({ directory })
        let current = await store.getRun(runId)
        if (current.ownerId !== before.ownerId || current.ownerEpoch !== before.ownerEpoch || action !== 'cancel' && current.revision !== before.revision) fail('任务版本或执行宿主发生变化，请重新确认。')
        if (current.binding?.accountId !== await currentArtifactAccountId()) fail('当前账号已变化，取消或执行授权不再有效。')
        if (action === 'cancel') {
          const value = await store.getTaskGraph({ runId, graphId })
          if (!value || value.revision !== graph.revision) fail('任务图已变化，请重新确认取消。')
          const next = structuredClone(value)
          next.cancelRequestedAt ||= Date.now()
          for (const item of next.nodes) if (['pending', 'ready', 'needs_review', 'failed'].includes(item.state)) item.state = 'cancelled'
          // Active/unknown children keep their evidence and state until the
          // executing host drains or reconciliation proves their outcome.
          next.status = next.nodes.every(item => item.state === 'accepted') ? 'accepted'
            : next.nodes.every(item => ['accepted', 'cancelled'].includes(item.state)) ? 'cancelled'
              : next.nodes.some(item => ['preparing', 'running'].includes(item.state)) ? 'running' : 'blocked'
          const result = await store.updateTaskGraph({ runId, expectedRevision: current.revision, ownerId: current.ownerId, ownerEpoch: current.ownerEpoch,
            graphId, expectedGraphRevision: value.revision, graph: next })
          render([result], options.json)
          return
        }
        await verifyRunHostBinding({ run: current, artifacts: createArtifactStore(), hostBindingHash: runHostBindingHash(meta) })
        const configState = await loadConfig(meta.sourceCwd), trustState = await checkWorkspaceTrust({ cwd: meta.sourceCwd, cliTrust: Boolean(options.trust), isTTY: Boolean(process.stdin.isTTY) })
        const dependencyEnvironment = await restoreRunEnvironment(meta.dependencyEnvironment, { cwd: meta.workspace, image: meta.image })
        host = graphHostFromMetadata({ meta, store, artifacts: createArtifactStore(), configState, trustState, dependencyEnvironment, authorize: (request, control) => {
          if (action === 'approve' && request.kind === 'task_graph.result' && request.nodeId === nodeId && request.graphId === graphId && request.revision === graph.revision && request.candidateHash === node.candidateHash) return { actorId: 'local_cli', reason: `Exact candidate confirmation ${confirmation}` }
          return confirmGraphActionInTerminal(request, control)
        } })
        if (action === 'execute' || action === 'recover') {
          current = await store.claimRun({ runId, expectedRevision: current.revision, expectedOwnerId: current.ownerId, expectedOwnerEpoch: current.ownerEpoch,
            ownerId: `graph_cli_${randomUUID()}`, approval: { approved: true, actorId: 'local_cli', reason: `Exact graph ${action} confirmation ${confirmation}` } })
          await host.recover(graphId, { parentRunId: runId, ownerEpoch: current.ownerEpoch })
          current = await store.getRun(runId)
          if (action === 'execute') {
            if (current.actions.some(value => ['prepared', 'unknown'].includes(value.state))) fail('父任务存在未知动作，请先核查；没有重复执行子任务。')
            current = await store.transitionRun({ runId, expectedRevision: current.revision, ownerId: current.ownerId, ownerEpoch: current.ownerEpoch, state: 'running', reason: 'User explicitly resumed eligible graph nodes' })
          }
        }
        const context = { parentRunId: runId, ownerEpoch: current.ownerEpoch }
        const result = action === 'approve' ? await host.approveResult(graphId, nodeId, { expectedRevision: graph.revision, candidateHash: node.candidateHash }, context)
          : action === 'recover' ? await host.inspect(graphId, context) : await host[action](graphId, context)
        render([result], options.json)
      } finally { try { await host?.close() } finally { try { await store?.close() } finally { await lease?.release() } } }
    })
  }
}
