import { runStoreError } from '../../storage/run-store-contracts.mjs'

export function normalizeRunHostBinding(value = null) {
  if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw runStoreError('HOST_BINDING_INVALID', '宿主执行配置绑定必须为 SHA-256，不能用模型 JSON 代替。')
  return value
}

/** Verify before takeover or execution. Legacy SDK runs may have no binding;
 * they can only be restored by a host that also explicitly supplies null. */
export async function verifyRunHostBinding({ run, artifacts, hostBindingHash = null }) {
  const expected = normalizeRunHostBinding(hostBindingHash)
  if (!run.binding?.contractApprovalRef) {
    if (expected !== null) throw runStoreError('HOST_BINDING_CHANGED', '任务没有可核验的宿主执行配置授权；请保留证据并新建确认任务。')
    return { verified: true, hostBindingHash: null }
  }
  const actor = { accountId: run.binding.accountId, projectId: run.binding.projectId, sessionId: run.binding.sessionId, runId: run.id }
  const id = run.binding.contractApprovalRef, metadata = await artifacts.getMetadata({ actor, id })
  if (metadata.size > 4 * 1024 * 1024) throw runStoreError('HOST_BINDING_INVALID', '宿主原始授权超过安全读取上限。')
  const chunks = []; let cursor, size = 0
  do {
    const page = await artifacts.read({ actor, id, cursor, limit: 256 * 1024 })
    const bytes = Buffer.from(page.data, 'base64'); size += bytes.length
    if (size > 4 * 1024 * 1024) throw runStoreError('HOST_BINDING_INVALID', '宿主原始授权超过安全读取上限。')
    chunks.push(bytes); cursor = page.nextCursor
  } while (cursor)
  let approval
  try { approval = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw runStoreError('HOST_BINDING_INVALID', '原始宿主授权无法解析；未重启模型或工具。') }
  if (approval.schema !== 'kk.run-contract-approval.v1' || normalizeRunHostBinding(approval.hostBindingHash ?? null) !== expected) throw runStoreError('HOST_BINDING_CHANGED', '当前宿主执行配置与原始批准不一致（来源、依赖、镜像或验收可能变化）；没有接管或执行，请保留资料并重新核查。')
  return { verified: true, hostBindingHash: expected }
}
