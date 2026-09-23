import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: statusCode === 409 ? 'connections_changed' : 'invalid_connection' })
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const fields = new Set(['id', 'name', 'host', 'port', 'username', 'remotePort', 'hostKey', 'folders'])

export function validateSshProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Connection must be an object')
  if (Object.keys(input).some(key => !fields.has(key))) throw error('Only connection metadata is accepted; passwords and private keys must stay on your device')
  const { name, host, username, hostKey = '', port = 22, remotePort = 18271, folders = 'home', id = randomUUID() } = input
  if (!validId(id) || typeof name !== 'string' || !name.trim() || Array.from(name).length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw error('Use a short single-line connection name')
  if (typeof host !== 'string' || host.length > 253 || !(isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) || host.includes('..')) throw error('Use an SSH hostname or IP address, without a URL or credentials')
  if (typeof username !== 'string' || !username || username.length > 128 || /[\s\p{Cc}\p{Cf}]/u.test(username)) throw error('Use a valid SSH username')
  if (![port, remotePort].every(value => Number.isInteger(value) && value >= 1 && value <= 65535)) throw error('Ports must be between 1 and 65535')
  if (typeof hostKey !== 'string' || hostKey && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(hostKey)) throw error('Use a confirmed SHA256 SSH host fingerprint')
  if (!['home', 'all'].includes(folders)) throw error('Select home or all ordinary folders explicitly')
  return { id, type: 'ssh', name: name.trim(), host, port, username, remotePort, hostKey, folders }
}

/** Account-scoped address book only. The gateway never connects to these hosts. */
export function registerSshProfiles({ app, store, authenticate, audit }) {
  async function load(req) {
    const { account } = await authenticate(req)
    const key = 'ssh-profiles:' + createHash('sha256').update(`${account.organization}\0${account.id}`).digest('hex')
    await store.putIfAbsent(key, { revision: 0, items: [] })
    return { account, key, value: await store.get(key) }
  }
  app.get('/api/v1/connections/ssh', async req => (await load(req)).value)
  async function change(req, remove = false) {
    const { key, value, account } = await load(req)
    const body = req.body || {}
    if (Object.keys(body).some(key => !['revision', 'connection'].includes(key))) throw error('Only connection metadata and revision are accepted')
    if (!Number.isSafeInteger(body.revision) || body.revision !== value.revision) throw error('Connections changed on another client; reload before saving', 409)
    let id, items
    if (remove) {
      id = req.params.id
      if (!validId(id)) throw error('Invalid connection id')
      items = value.items.filter(item => item.id !== id)
    } else {
      const profile = validateSshProfile(body.connection)
      id = profile.id
      const existing = value.items.find(item => item.id === id)
      // A host/identity change must be explicitly verified again on the client.
      if (existing && (existing.host !== profile.host || existing.port !== profile.port || existing.username !== profile.username)) profile.hostKey = ''
      items = [...value.items.filter(item => item.id !== id), profile]
      if (items.length > 100) throw error('An account can save at most 100 SSH connections')
    }
    const next = { revision: value.revision + 1, items }
    if (!await store.comparePut(key, value, next)) throw error('Connections changed on another client; reload before saving', 409)
    await audit?.(remove ? 'ssh-profile.delete' : 'ssh-profile.save', account.id, id)
    return next
  }
  app.post('/api/v1/connections/ssh', async req => change(req))
  app.post('/api/v1/connections/ssh/:id/delete', async req => change(req, true))
}
