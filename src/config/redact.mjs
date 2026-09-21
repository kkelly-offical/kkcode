// Display redaction is deliberately key-based, so unfamiliar credential formats
// cannot bypass it. Environment-variable *names* are configuration, not secrets.
const secretKey = /(?:^|[_-])(?:api[_-]?key|secret|password|passwd|token|authorization|cookie|private[_-]?key)(?:$|[_-])/i
export function isSecretConfigPath(path) {
  return String(path).split('.').some(key => !/_env$/i.test(key) && secretKey.test(key))
}
export function redactConfig(value, path = '') {
  if (isSecretConfigPath(path)) return value == null || value === '' ? value : '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redactConfig(item, path))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactConfig(item, path ? `${path}.${key}` : key)]))
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.username || url.password) { url.username = 'REDACTED'; url.password = '' }
      for (const key of url.searchParams.keys()) if (isSecretConfigPath(key)) url.searchParams.set(key, '[REDACTED]')
      return url.href
    } catch { return value }
  }
  return value
}
