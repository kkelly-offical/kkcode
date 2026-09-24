import { randomUUID, createHash } from 'node:crypto'
import { getSession, replaceMessages, flushNow } from '../session/store.mjs'
import { runStoreError } from '../../storage/run-store-contracts.mjs'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fail = message => { throw runStoreError('RECOVERY_HISTORY_UNVERIFIED', message) }

/** Repair only a missing protocol response, never remove the original tool call
 * or invent an execution result. The caller provides a trusted artifact reader. */
export async function repairRunHistory({ run, readResult }) {
  const sessionId = run.binding.sessionId
  const saved = await getSession(sessionId)
  if (!saved?.messages?.length) return { repaired: 0 }
  const observedMessages = structuredClone(saved.messages)
  const expectedSession = Object.fromEntries(['model', 'providerType', 'historyRevision', 'updatedAt', 'cwd'].map(key => [key, saved.session[key]]))
  const messages = structuredClone(observedMessages)
  let repaired = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const calls = message.content.filter(block => block.type === 'tool_use')
    if (!calls.length) continue
    if (new Set(calls.map(call => call.id)).size !== calls.length) fail('同一回复包含重复工具调用 ID，无法唯一恢复结果。')
    const next = messages[index + 1]
    const existingResults = next?.role === 'user' && Array.isArray(next.content) ? next.content.filter(block => block.type === 'tool_result') : []
    const present = new Set(existingResults.map(block => block.tool_use_id))
    if (present.size !== existingResults.length || existingResults.some(result => !calls.some(call => call.id === result.tool_use_id))) fail('工具结果重复或不属于前一条调用，已停止发送无效模型请求。')
    const missing = calls.filter(call => !present.has(call.id))
    if (!missing.length) continue
    const results = []
    for (const call of missing) {
      const matches = run.actions.filter(action => action.context?.sessionId === sessionId && action.context.turnId === message.turnId && action.context.invocationId === call.id && action.kind === `tool.${call.name}` && action.parameterHash === hash(call.input || {}))
      if (matches.length !== 1) fail('旧工具调用缺少唯一的持久操作记录；未删除调用，也未假装未执行。请在本机核查历史。')
      const action = matches[0]
      if (['prepared', 'unknown'].includes(action.state)) fail('原工具调用的副作用仍未核查，不能合成成功响应或继续发送模型请求。')
      let original = null
      for (const reference of action.receipt?.evidenceRefs || []) {
        const candidate = await readResult(reference)
        if (candidate?.actionId === action.id && candidate.result && typeof candidate.result.output === 'string') { original = candidate.result; break }
      }
      const refs = action.receipt?.evidenceRefs || []
      if (!refs.length) fail('工具调用结果没有可回查的宿主证据，已停止恢复。')
      const content = original
        ? `[Recovered durable tool receipt; the original conversation response was interrupted.]\n${original.output.slice(0, 16_000)}${original.output.length > 16_000 ? '\n[Recovered display truncated; read the evidence artifact for the complete result.]' : ''}\nEvidence: ${refs.join(', ')}`
        : `[Host recovery receipt: the original tool response was lost. The host inspected the operation and recorded state=${action.state}. This is a reconciliation record, not a recreated original output.]\n${action.receipt.summary || ''}\nEvidence: ${refs.join(', ')}`
      results.push({ type: 'tool_result', tool_use_id: call.id, content, is_error: action.state !== 'succeeded' })
      repaired++
    }
    if (next?.role === 'user' && Array.isArray(next.content) && next.content.some(block => block.type === 'tool_result')) {
      next.content = [...next.content.filter(block => block.type === 'tool_result'), ...results, ...next.content.filter(block => block.type !== 'tool_result')]
    } else {
      messages.splice(index + 1, 0, { id: `msg_${randomUUID().replaceAll('-', '').slice(0, 12)}`, role: 'user', content: results, createdAt: Date.now(), turnId: message.turnId, recoveredFromRun: run.id })
      index++
    }
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'user' || !Array.isArray(message.content) || !message.content.some(block => block.type === 'tool_result')) continue
    const previous = messages[index - 1]
    if (previous?.role !== 'assistant' || !Array.isArray(previous.content) || !previous.content.some(block => block.type === 'tool_use')) fail('会话包含孤立工具结果，请在本机核查记录；未将其当成普通用户输入。')
  }
  if (!repaired) return { repaired: 0 }
  const outcome = await replaceMessages(sessionId, messages, { observedMessages, expectedSession })
  if (!outcome.replaced) throw runStoreError('RECOVERY_HISTORY_CHANGED', '恢复工具响应时会话已经变化，请重新读取后恢复；未覆盖新消息。')
  await flushNow()
  return { repaired }
}
