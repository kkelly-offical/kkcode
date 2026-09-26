// Device clients receive actionable diagnostics, never raw schema errors. Raw
// errors can quote a malformed value (including a pasted credential) or path.
const permissionFields = new Set(['permission', 'permission.level', 'permission.mode',
  'permission.default_policy', 'permission.non_tty_default', 'permission.auto_review',
  'permission.rules', 'permission.sandbox', 'permission.sandbox.mode',
  'permission.sandbox.network', 'permission.sandbox.writable_dirs'])

function diagnostic(error, state) {
  let text = String(error), source = '有效配置'
  for (const [key, label] of [['userPath', '用户配置'], ['projectPath', '项目配置'], ['envPath', '环境配置']]) {
    const file = state.source?.[key]
    if (file && text.startsWith(`${file}: `)) { text = text.slice(file.length + 2); source = label; break }
  }
  const candidate = text.slice(0, text.indexOf(': '))
  const field = candidate === 'data_policy' ? candidate : permissionFields.has(candidate) ? candidate : /^permission\.rules\[\d+\]\.[a-z_]+$/.test(candidate) ? 'permission.rules' : ''
  let message = '配置未通过校验。请在被控电脑运行 kkcode preflight 查看具体位置，修正配置后重新加载。'
  if (field.startsWith('permission')) message = '权限配置无效，已暂停工具执行；有效的模型和其他配置仍保留。请修正该字段后重新加载。'
  if (field === 'data_policy') message = '数据出域策略无效，已拒绝所有受管理的出站请求。请修正 data_policy 后重新加载；本地工具仍按独立权限配置处理。'
  if (field === 'permission.default_policy') message = '旧字段已移除，请手动迁移到 permission.level：allow → accept-edits，deny → readonly，ask → manual；修正前工具执行暂停。'
  if (field === 'permission.mode' || field === 'permission.level') message = '请使用 permission.level：readonly、manual、accept-edits 或 yolo。旧 auto/review 对应 manual，edit/full-auto 对应 accept-edits；不会自动扩大权限。'
  return { source, field, message }
}

export function configurationDiagnostics(state) {
  const errors = Array.isArray(state.errors) ? state.errors : []
  const warnings = Array.isArray(state.warnings) ? state.warnings : []
  return {
    toolsBlocked: state.permissionBlocked === true,
    errors: errors.slice(0, 16).map(error => diagnostic(error, state)),
    errorCount: errors.length,
    warningCount: warnings.length,
    ...(warnings.length ? { warning: '部分无效配置项未生效。请在被控电脑运行 kkcode preflight 检查；不影响其他已验证配置。' } : {})
  }
}

export function configurationErrorMessage(errors) {
  const fields = errors.map(error => diagnostic(error, {})).filter(item => item.field)
  return fields.length
    ? `配置未保存：${fields[0].field}。${fields[0].message}`
    : '配置未保存：合并后的用户配置未通过校验。请在被控电脑运行 kkcode preflight，修正原有配置后重试；原文件未修改。'
}
