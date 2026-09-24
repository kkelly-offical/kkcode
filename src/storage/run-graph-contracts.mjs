import { createHash } from 'node:crypto'
import { object, text, id, integer, hash, oneOf, runStoreError } from './run-store-contracts.mjs'

export const TASK_GRAPH_STATES = Object.freeze(['pending', 'running', 'needs_review', 'accepted', 'blocked', 'cancelled'])
export const TASK_NODE_STATES = Object.freeze(['pending', 'preparing', 'ready', 'running', 'needs_review', 'accepted', 'failed', 'unknown', 'cancelled'])
const fail = message => { throw runStoreError('INVALID_TASK_GRAPH', message) }
const copy = value => structuredClone(value)
const immutableNode = ['id', 'prompt', 'role', 'dependsOn', 'budgetUsd', 'deadlineAt', 'childRunId', 'sessionId', 'tools', 'criteria']
const immutableGraph = ['id', 'createdAt', 'deadlineAt', 'budgetUsd', 'maxConcurrency', 'parentCandidateHash', 'baseRevision', 'proposalHash', 'approvalRef']
const transitions = {
  pending: ['pending', 'preparing', 'cancelled'], preparing: ['preparing', 'ready', 'unknown', 'cancelled'],
  ready: ['ready', 'running', 'unknown', 'cancelled'], running: ['running', 'needs_review', 'failed', 'unknown', 'cancelled'],
  needs_review: ['needs_review', 'accepted', 'unknown', 'cancelled'], accepted: ['accepted', 'unknown'],
  failed: ['failed', 'cancelled'], unknown: ['unknown', 'ready', 'needs_review', 'failed', 'cancelled'], cancelled: ['cancelled', 'unknown']
}
function money(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) fail(`${label} 必须是非负有限 USD 金额。`)
  return value
}
function nullable(value, check) { return value == null ? null : check(value) }
function ids(value, label, max = 32) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} 数量超过限制。`)
  const result = value.map(item => id(item, label))
  if (new Set(result).size !== result.length) fail(`${label} 不能重复。`)
  return result
}

/** Bounded, deterministic snapshot. No confirmation tokens, credentials, model
 * modes or arbitrary host callback selectors can enter the persistent graph. */
export function normalizeTaskGraph(input) {
  object(input, ['version', 'id', 'revision', 'ownerEpoch', 'createdAt', 'deadlineAt', 'budgetUsd', 'maxConcurrency', 'parentCandidateHash', 'baseRevision', 'proposalHash', 'approvalRef', 'cancelRequestedAt', 'status', 'nodes'], 'taskGraph')
  if (input.version !== 1) fail('任务图版本不支持。')
  if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 32) fail('任务图应包含 1–32 个节点。')
  const graph = {
    version: 1, id: id(input.id, 'graph.id'), revision: integer(input.revision ?? 0, 'graph.revision'),
    ownerEpoch: integer(input.ownerEpoch, 'graph.ownerEpoch', 1), createdAt: integer(input.createdAt, 'graph.createdAt', 1),
    deadlineAt: integer(input.deadlineAt, 'graph.deadlineAt', 1), budgetUsd: money(input.budgetUsd, 'graph.budgetUsd'),
    maxConcurrency: integer(input.maxConcurrency, 'graph.maxConcurrency', 1, 8), parentCandidateHash: hash(input.parentCandidateHash),
    baseRevision: text(input.baseRevision, 'graph.baseRevision', 64), proposalHash: hash(input.proposalHash), approvalRef: text(input.approvalRef, 'graph.approvalRef', 256),
    status: oneOf(input.status, TASK_GRAPH_STATES, 'graph.status'), nodes: []
  }
  graph.cancelRequestedAt = nullable(input.cancelRequestedAt, value => integer(value, 'graph.cancelRequestedAt', graph.createdAt))
  if (!/^[a-f0-9]{40,64}$/.test(graph.baseRevision) || graph.deadlineAt <= graph.createdAt || graph.deadlineAt - graph.createdAt > 7 * 24 * 60 * 60 * 1000) fail('任务图基线或最长七天期限无效。')
  graph.nodes = input.nodes.map(node => {
    object(node, [...immutableNode, 'state', 'workspace', 'candidateHash', 'evidenceRefs', 'resultArtifactRef', 'parentResultRef', 'approvalRef', 'costUsd', 'errorCode', 'startedAt', 'finishedAt'], 'taskGraph.node')
    if (!Array.isArray(node.criteria) || !node.criteria.length || node.criteria.length > 20) fail('子任务必须有 1–20 项宿主验收条件。')
    const criteria = node.criteria.map(criterion => { object(criterion, ['id', 'description'], 'graph.criterion'); return { id: id(criterion.id), description: text(criterion.description, 'criterion.description', 2048) } })
    if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) fail('子任务验收条件 ID 不能重复。')
    return {
      id: id(node.id, 'node.id'), prompt: text(node.prompt, 'node.prompt', 8192), role: oneOf(node.role, ['review', 'writer'], 'node.role'),
      dependsOn: ids(node.dependsOn, 'node.dependsOn'), budgetUsd: money(node.budgetUsd, 'node.budgetUsd'), deadlineAt: integer(node.deadlineAt, 'node.deadlineAt', 1, graph.deadlineAt),
      childRunId: id(node.childRunId, 'node.childRunId'), sessionId: id(node.sessionId, 'node.sessionId'), tools: ids(node.tools, 'node.tools', 64), criteria,
      state: oneOf(node.state, TASK_NODE_STATES, 'node.state'), workspace: nullable(node.workspace, value => text(value, 'node.workspace')),
      candidateHash: nullable(node.candidateHash, value => hash(value)), evidenceRefs: ids(node.evidenceRefs ?? [], 'node.evidenceRefs', 100),
      resultArtifactRef: nullable(node.resultArtifactRef, value => id(value)), approvalRef: nullable(node.approvalRef, value => id(value)),
      parentResultRef: nullable(node.parentResultRef, value => id(value)),
      costUsd: money(node.costUsd ?? 0, 'node.costUsd'), errorCode: nullable(node.errorCode, value => id(value)),
      startedAt: nullable(node.startedAt, value => integer(value, 'node.startedAt', graph.createdAt)),
      finishedAt: nullable(node.finishedAt, value => integer(value, 'node.finishedAt', graph.createdAt))
    }
  })
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]))
  if (nodeMap.size !== graph.nodes.length || new Set(graph.nodes.map(node => node.childRunId)).size !== graph.nodes.length || new Set(graph.nodes.map(node => node.sessionId)).size !== graph.nodes.length) fail('逻辑子任务、执行任务和会话 ID 必须唯一。')
  if (graph.nodes.reduce((total, node) => total + node.budgetUsd, 0) > graph.budgetUsd + Number.EPSILON * 32) fail('子任务预留预算之和超过任务图总预算。')
  const visited = new Set(), visiting = new Set()
  function visit(node) {
    if (visiting.has(node.id)) fail('子任务依赖不能成环。')
    if (visited.has(node.id)) return
    visiting.add(node.id)
    for (const dependency of node.dependsOn) {
      const target = nodeMap.get(dependency)
      if (!target) fail('子任务依赖引用不存在。')
      visit(target)
    }
    visiting.delete(node.id); visited.add(node.id)
  }
  for (const node of graph.nodes) {
    visit(node)
    if (node.deadlineAt <= graph.createdAt) fail('子任务期限早于任务创建。')
    if (node.role === 'review' && node.tools.some(tool => !['read', 'list', 'artifact_read', 'artifact_search'].includes(tool))) fail('默认评审子任务只能使用只读工具。')
    if (['ready', 'running', 'needs_review', 'accepted'].includes(node.state) && !node.workspace) fail('子任务未绑定独立工作树。')
    if (['needs_review', 'accepted'].includes(node.state) && (!node.candidateHash || !node.resultArtifactRef || !node.evidenceRefs.length)) fail('子任务结果缺少候选或证据。')
    if (node.state === 'accepted' && !node.approvalRef) fail('子任务结果缺少宿主核准。')
    if (['preparing', 'ready', 'running', 'needs_review', 'accepted'].includes(node.state) && node.dependsOn.some(dependency => nodeMap.get(dependency).state !== 'accepted')) fail('依赖未经核准，不能启动下游任务。')
  }
  if (graph.status === 'accepted' && graph.nodes.some(node => node.state !== 'accepted')) fail('不能仅凭文本把整个任务图标记为完成。')
  if (graph.status === 'cancelled' && graph.nodes.some(node => ['preparing', 'ready', 'running', 'unknown'].includes(node.state))) fail('仍有活跃或未知子任务，取消尚未收束。')
  if (Buffer.byteLength(JSON.stringify(graph)) > 192 * 1024) fail('任务图超过 192 KiB，请缩小任务说明。')
  return graph
}

/** @param {any} previous @param {any} next @param {{ownerEpoch?:number}} options */
export function assertTaskGraphTransition(previous, next, { ownerEpoch } = {}) {
  const normalized = normalizeTaskGraph(next)
  if (ownerEpoch !== undefined && normalized.ownerEpoch !== ownerEpoch) fail('任务图执行代次不属于当前宿主。')
  if (!previous) {
    if (normalized.revision !== 0 || normalized.status !== 'pending' || normalized.nodes.some(node => node.state !== 'pending')) fail('新任务图必须从未执行状态开始。')
    return normalized
  }
  const prior = normalizeTaskGraph(previous)
  if (normalized.revision !== prior.revision || normalized.ownerEpoch < prior.ownerEpoch) fail('任务图版本或执行代次已过期。')
  if (prior.cancelRequestedAt && prior.cancelRequestedAt !== normalized.cancelRequestedAt) fail('不能撤回已持久化的取消请求。')
  for (const key of immutableGraph) if (JSON.stringify(prior[key]) !== JSON.stringify(normalized[key])) fail('已确认任务图的范围、预算、期限和基线不可静默修改。')
  if (prior.nodes.length !== normalized.nodes.length) fail('不能为已确认任务图添加新的逻辑子任务。')
  for (let index = 0; index < prior.nodes.length; index++) {
    const before = prior.nodes[index], after = normalized.nodes[index]
    for (const key of immutableNode) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) fail('子任务逻辑 ID、依赖、范围或预算不可改变。')
    if (!transitions[before.state].includes(after.state)) fail('子任务状态转换无效，未自动重新执行。')
    if (before.workspace && before.workspace !== after.workspace || before.costUsd > after.costUsd) fail('子任务工作树或已消耗预算不可重置。')
    if (before.state === 'accepted' && after.state === 'accepted' && ['candidateHash', 'evidenceRefs', 'resultArtifactRef', 'parentResultRef', 'approvalRef'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) fail('已核准子任务的候选和证据不可静默替换。')
    if (normalized.ownerEpoch !== prior.ownerEpoch && ['preparing', 'running'].includes(before.state) && after.state !== 'unknown') fail('接管必须先核查旧子任务，不能自动重建或重放。')
  }
  return normalized
}

export function taskGraphDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export function taskGraphComplete(graph) { const value = normalizeTaskGraph(copy(graph)); return value.status === 'accepted' || value.status === 'cancelled' }
