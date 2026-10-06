import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { encryptedStore } from '../storage/encrypted-store.mjs'
import { validateConfig } from '../config/schema.mjs'
import { DEFAULT_CONFIG } from '../config/defaults.mjs'
import { redactConfig } from '../config/redact.mjs'
import { withoutModelTokenLimits } from '../config/model-token-limits.mjs'

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'account_models' })
function merge(base, patch) {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw error('配置字段无效。')
    if (value === '[REDACTED]') continue
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key], value) : value
  }
  return result
}
export function registerAccountModels({ app, store, authenticate, origin, encryptionKey, clientSecret, cluster = false }) {
  let keyPromise
  async function key() {
    if (!keyPromise) keyPromise = (async () => {
      if (encryptionKey) {
        if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)) throw error('账号配置加密密钥配置无效。', 503)
        return Buffer.from(encryptionKey, 'base64')
      }
      if (clientSecret) return createHash('sha256').update(`kkcode-account-models-v1\0${origin}\0${clientSecret}`).digest()
      if (cluster) throw error('集群尚未配置账号模型同步。', 503)
      const vault = encryptedStore(`gateway-models-key:${origin}`)
      const saved = await vault.update(value => value.key ? value : { key: randomBytes(32).toString('base64') })
      return Buffer.from(saved.key, 'base64')
    })()
    return keyPromise
  }
  async function read(account) {
    const id = `account-models:${account.id}`, saved = await store.get(id)
    if (!saved) return { id, revision: 0, provider: {}, updatedAt: null, saved: null }
    try {
      const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(saved.iv, 'base64'))
      decipher.setAAD(Buffer.from(`${origin}\0${account.id}`)); decipher.setAuthTag(Buffer.from(saved.tag, 'base64'))
      const provider = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8'))
      return { id, saved, revision: saved.revision, updatedAt: saved.updatedAt, provider }
    } catch { throw error('账号模型配置暂时无法解密，请联系网关管理员恢复加密密钥。', 503) }
  }
  async function result(req, reply, secrets = false) {
    reply.header('Cache-Control', 'no-store')
    const { account } = await authenticate(req), value = await read(account)
    return { accountId: account.id, gateway: origin, revision: value.revision, updatedAt: value.updatedAt, provider: secrets ? value.provider : redactConfig(value.provider) }
  }
  app.get('/api/v1/account/models', (req, reply) => result(req, reply))
  app.post('/api/v1/account/models/resolve', (req, reply) => result(req, reply, true))
  app.post('/api/v1/account/models', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { account } = await authenticate(req), before = await read(account)
    if (!Number.isSafeInteger(req.body?.revision) || req.body.revision !== before.revision) throw error('账号配置已在其他设备更新，请刷新后再保存。', 409)
    const patch = req.body?.provider
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024) throw error('模型配置无效或过大。')
    const provider = withoutModelTokenLimits({ provider: merge(before.provider, patch) }).provider
    const validation = validateConfig({ ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, ...provider } })
    if (!validation.valid) throw error('模型渠道配置无效，请检查地址、协议和模型名称。')
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv)
    cipher.setAAD(Buffer.from(`${origin}\0${account.id}`))
    const data = Buffer.concat([cipher.update(JSON.stringify(provider)), cipher.final()])
    const saved = { revision: before.revision + 1, updatedAt: Date.now(), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
    const applied = before.saved ? await store.comparePut(before.id, before.saved, saved) : await store.putIfAbsent(before.id, saved)
    if (!applied) throw error('账号配置已在其他设备更新，请刷新后再保存。', 409)
    return { accountId: account.id, gateway: origin, revision: saved.revision, updatedAt: saved.updatedAt, provider: redactConfig(provider) }
  })
}
