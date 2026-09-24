// Host-only provenance. Error codes / booleans crossing tool IPC are diagnostics,
// never evidence that an effect did not happen. This module is not an SDK export.
const preDispatchFailures = new WeakSet()

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
