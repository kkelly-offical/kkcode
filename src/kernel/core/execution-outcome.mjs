// Host-only provenance. Error codes / booleans crossing tool IPC are diagnostics,
// never evidence that an effect did not happen. This module is not an SDK export.
const preDispatchFailures = new WeakSet()
const notStartedReceipts = new WeakSet()
const dispatchReceipts = new WeakMap()
const noMutationReceipts = new WeakMap()
const trustedNoMutation = new WeakSet()

/** Native transaction validation proved that no target was written. This is
 * distinct from not dispatching the tool, and cannot be minted by IPC metadata. */
export function markToolNoMutation(result) {
  const receipt = Object.freeze({schema: 'kk.tool-mutation.v1', source: 'host', changed: false})
  trustedNoMutation.add(receipt)
  noMutationReceipts.set(result, receipt)
  return result
}
export const toolMutationReceipt = result => noMutationReceipts.get(result) || null
export const isToolNoMutation = result => Boolean(toolMutationReceipt(result))
export function attachToolMutationReceipt(result, receipt) {
  if (receipt && trustedNoMutation.has(receipt)) noMutationReceipts.set(result, receipt)
  return result
}
/** Only the canonical host history reader restores this top-level receipt. */
export function restoreToolMutationReceipt(result, receipt) {
  if (receipt?.schema === 'kk.tool-mutation.v1' && receipt.source === 'host' && receipt.changed === false) markToolNoMutation(result)
  return result
}

/** Minted only before the host dispatch boundary, never from a tool's code,
 * status, output, or metadata. Brands survive host result transformations. */
export function markToolNotStarted(result) {
  const receipt = Object.freeze({schema: 'kk.tool-dispatch.v1', source: 'host', started: false})
  notStartedReceipts.add(receipt)
  dispatchReceipts.set(result, receipt)
  return result
}
export const toolDispatchReceipt = result => dispatchReceipts.get(result) || null
export const isToolNotStarted = result => Boolean(toolDispatchReceipt(result))
export function attachToolDispatchReceipt(result, receipt) {
  if (receipt && notStartedReceipts.has(receipt)) dispatchReceipts.set(result, receipt)
  return result
}
/** Called only by the canonical host history reader, not on tool metadata. */
export function restoreToolDispatchReceipt(result, receipt) {
  if (receipt?.schema === 'kk.tool-dispatch.v1' && receipt.source === 'host' && receipt.started === false) markToolNotStarted(result)
  return result
}

export function toolPreDispatchError(cause) {
  const original = cause?.message || String(cause)
  const message = ['workspace_path_violation', 'strict_workspace_violation'].includes(cause?.code)
    ? `路径请求在执行前被拒绝，未写入目标文件。请使用任务工作区内的相对路径或 /workspace/...；不允许访问工作区外的目录、上级目录逃逸或越界软链接。原始原因：${original}`
    : `工具请求在执行前被拒绝，本次操作尚未执行。原始原因：${original}`
  const error = Object.assign(new Error(message, { cause }), {
    name: cause?.name || 'Error',
    ...(cause?.code ? { code: cause.code } : {}),
    operationNotStarted: true
  })
  preDispatchFailures.add(error)
  return error
}

export function isToolPreDispatchError(error) {
  return Boolean(error && typeof error === 'object' && preDispatchFailures.has(error))
}
