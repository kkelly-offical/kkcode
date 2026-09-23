const messages = {
  unknown_provider: '当前电脑未配置所选模型渠道。请在这台电脑的“模型与渠道”中选择或添加，其他设备的配置不会自动适用。',
  invalid_model: '模型 ID 无效，请从当前渠道重新选择，或填写模型服务实际提供的 ID。',
  unknown_method: '被控电脑不支持这项操作，请升级该电脑上的 KK Code CLI；只升级网关或客户端不会更新电脑。',
  login_required: '登录或配对已过期，请重新登录或配对。',
  pairing_denied: '配对码无效或已过期，请在被控电脑重新生成后再试。',
  session_missing: '这段对话已不存在，请返回会话列表重新选择。',
  invalid_request_time: '客户端与服务器时间相差过大，请同步系统时间后重新连接。',
  control_required: '当前没有会话控制权，请先获取控制权后再操作。',
  control_busy: '另一客户端正在控制这段会话，请等待完成或由设备所有者明确接管。',
  turn_busy: '当前任务仍在运行，请等待完成或先停止任务后再操作。',
  outcome_unknown: '上一项操作可能已经执行，请先刷新会话核对结果，不要重复提交文件修改。',
};
export function remoteErrorMessage(error) {
  if (messages[error?.code]) return messages[error.code];
  if (/Credential files/i.test(String(error?.message || ''))) return '凭据文件不能作为附件上传。请移除 .env、私钥或其他含密钥的文件后重试。';
  const text = String(error?.message || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]')
    .replace(/(api[_-]?key|token|password|secret)([\s"']*[:=][\s"']*)[^\s"'&,;]+/gi, '$1$2[已隐藏]').slice(0, 700);
  if (/[\u4e00-\u9fff]/u.test(String(error?.message || ''))) return text;
  if (error?.status === 500) return '服务内部处理失败（HTTP 500）。请在被控电脑运行 kkcode doctor 检查配置；若是网关请求，请管理员检查网关日志。';
  if ([502, 503, 504].includes(error?.status)) return `远端服务暂时不可用（HTTP ${error.status}）。请检查设备在线状态和网络；重试前先核对上一项操作结果。`;
  if (error?.status === 401) return '登录或配对已过期，请重新登录后再试。';
  if (error?.status === 403) return '当前账号或目录授权不允许此操作，请联系设备所有者检查权限。';
  if (error?.status === 404) return '请求的服务或内容不存在，请核对地址与设备 CLI/网关版本。';
  if (error?.status === 429) return '请求过于频繁，请稍后重试。';
  if (/fetch|network|connection/i.test(text) && !error?.status) return '网络连接暂不可用，请检查网络与服务地址后重试。';
  return `操作未完成${error?.status ? `（HTTP ${error.status}）` : ''}，请核对当前设备的配置与输入。${text && !/^(Bad Request|HTTP \d+|Internal Server Error)$/.test(text) ? `\n详细原因：${text}` : ''}`;
}
