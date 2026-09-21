import pg from 'pg'
const expiringPrefixes = ['token:', 'refresh:', 'identity-session:', 'login-code:', 'oidc-flow:', 'device-unbind-receipt:', 'route:']
export class MemoryStore {
  constructor() { this.data = new Map() }
  async get(key) { return structuredClone(this.data.get(key) || null) }
  async put(key, value) { this.data.set(key, structuredClone(value)) }
  async delete(key) { this.data.delete(key) }
  async compareDelete(key, expected) { if (JSON.stringify(this.data.get(key)) !== JSON.stringify(expected)) return false; return this.data.delete(key) }
  async take(key) { const value = this.data.get(key); this.data.delete(key); return structuredClone(value || null) }
  async comparePut(key, expected, value) { if (JSON.stringify(this.data.get(key)) !== JSON.stringify(expected)) return false; this.data.set(key, structuredClone(value)); return true }
  async list(prefix) { return [...this.data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, ...structuredClone(value) })) }
  async prune({ now = Date.now(), auditRetentionMs = 90 * 86400000, maxAudit = 100000 } = {}) {
    for (const [key, value] of this.data) {
      if (expiringPrefixes.some(prefix => key.startsWith(prefix)) && Number.isFinite(value.expires) && value.expires <= now) this.data.delete(key)
      if (key.startsWith('audit:') && value.timestamp < now - auditRetentionMs) this.data.delete(key)
    }
    const audits = [...this.data].filter(([key]) => key.startsWith('audit:')).sort((a, b) => b[1].timestamp - a[1].timestamp)
    for (const [key] of audits.slice(maxAudit)) this.data.delete(key)
    for (const [key, value] of this.data) if (key.startsWith('login-user:') && !this.data.has(value.codeKey)) this.data.delete(key)
  }
  async close() {}
}
export class PostgresStore {
  constructor(url) {
    this.pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000, query_timeout: 5000, max: 20 })
    // An idle connection loss must not become an unhandled EventEmitter error.
    // Requests/readiness expose a sanitized 503 while the pool reconnects.
    this.pool.on('error', () => {})
  }
  async query(sql, values) {
    try { return await this.pool.query(sql, values) }
    catch { throw Object.assign(new Error('Gateway data store unavailable; retry after service recovery'), { statusCode: 503, code: 'database_unavailable' }) }
  }
  async initialize() { await this.query('CREATE TABLE IF NOT EXISTS kkcode_gateway (key text PRIMARY KEY, value jsonb NOT NULL)'); return this }
  async get(key) { return (await this.query('SELECT value FROM kkcode_gateway WHERE key = $1', [key])).rows[0]?.value || null }
  async put(key, value) { await this.query('INSERT INTO kkcode_gateway(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]) }
  async delete(key) { await this.query('DELETE FROM kkcode_gateway WHERE key=$1', [key]) }
  async compareDelete(key, expected) { return (await this.query('DELETE FROM kkcode_gateway WHERE key=$1 AND value=$2', [key, JSON.stringify(expected)])).rowCount === 1 }
  async take(key) { return (await this.query('DELETE FROM kkcode_gateway WHERE key=$1 RETURNING value', [key])).rows[0]?.value || null }
  async comparePut(key, expected, value) { return (await this.query('UPDATE kkcode_gateway SET value=$3 WHERE key=$1 AND value=$2', [key, JSON.stringify(expected), JSON.stringify(value)])).rowCount === 1 }
  async list(prefix) { return (await this.query('SELECT key,value FROM kkcode_gateway WHERE starts_with(key,$1)', [prefix])).rows.map(row => ({ key: row.key, ...row.value })) }
  async prune({ now = Date.now(), auditRetentionMs = 90 * 86400000, maxAudit = 100000 } = {}) {
    await this.query("DELETE FROM kkcode_gateway WHERE key LIKE ANY($1) AND CASE WHEN jsonb_typeof(value->'expires')='number' THEN (value->>'expires')::numeric <= $2 ELSE false END", [expiringPrefixes.map(prefix => `${prefix}%`), now])
    await this.query("DELETE FROM kkcode_gateway WHERE key LIKE 'audit:%' AND (value->>'timestamp')::numeric < $1", [now - auditRetentionMs])
    await this.query("DELETE FROM kkcode_gateway WHERE key IN (SELECT key FROM kkcode_gateway WHERE key LIKE 'audit:%' ORDER BY (value->>'timestamp')::numeric DESC OFFSET $1)", [maxAudit])
    await this.query("DELETE FROM kkcode_gateway mapping WHERE mapping.key LIKE 'login-user:%' AND NOT EXISTS (SELECT 1 FROM kkcode_gateway code WHERE code.key=mapping.value->>'codeKey')")
  }
  async close() { await this.pool.end() }
}
