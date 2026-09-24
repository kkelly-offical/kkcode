/** Memory is a small, reviewable reference store, not an instruction channel or
 * a credential vault. Automatic facts never copy arbitrary document values. */
const SENSITIVE_LABEL = /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|client[_ -]?secret|authorization|cookie|私钥|密码|密钥)\s*[=:：]\s*\S+/i
const KNOWN_SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,})/
const AUTHORITY_OVERRIDE = /(?:ignore|disregard|override|forget)\s+(?:(?:all|previous|system|developer|safety)\s+){1,3}(?:instructions?|prompts?|rules?)|(?:bypass|disable|skip)\s+(?:all\s+)?(?:approvals?|permissions?|safety|sandbox)|(?:忽略|覆盖|绕过|关闭|跳过).{0,12}(?:系统提示|开发者指令|安全规则|权限检查|审批)|<\/?(?:system|developer|memory|script)\b/i
const SECRET_ENV = /(?:key|token|secret|password|passwd|credential|cookie|authorization)/i

export class MemoryError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'MemoryError'; this.code = code; this.status = status }
}

export function checkedMemoryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new MemoryError('memory_invalid_text', '记忆必须是 1–2000 字符的普通文本，不能含控制字符。')
  }
  const text = value.trim()
  if (SENSITIVE_LABEL.test(text) || KNOWN_SECRET.test(text)) throw new MemoryError('memory_sensitive', '内容疑似包含凭据或秘密，未写入记忆；请去掉敏感值后重试。')
  for (const [name, secret] of Object.entries(process.env)) if (SECRET_ENV.test(name) && secret?.length >= 6 && text.includes(secret)) {
    throw new MemoryError('memory_sensitive', '内容包含当前环境的敏感值，未写入记忆。')
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0])
      if (url.username || url.password || [...url.searchParams.keys()].some(key => SECRET_ENV.test(key))) throw new MemoryError('memory_sensitive', '记忆不能保存含登录信息或凭据参数的链接。')
    } catch (error) { if (error instanceof MemoryError) throw error }
  }
  // Unknown high-entropy credential-like strings are rejected conservatively.
  if (text.split(/\s+/).some(word => word.length >= 40 && /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word) && /^[A-Za-z0-9_+/=.-]+$/.test(word))) {
    throw new MemoryError('memory_sensitive', '内容包含疑似秘密的长字符串，未写入记忆。')
  }
  if (AUTHORITY_OVERRIDE.test(text)) throw new MemoryError('memory_instruction_override', '记忆不能覆盖系统规则、权限或审批；请只保存可核验的项目事实或普通偏好。')
  return text
}

export const memoryJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
