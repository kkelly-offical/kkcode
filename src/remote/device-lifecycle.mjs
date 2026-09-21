import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { acquireProcessLock } from '../storage/process-lock.mjs'

const idPattern = /^[A-Za-z0-9_-]{1,128}$/
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status, statusCode: status })
const hash = value => createHash('sha256').update(value).digest('hex')
const paths = root => ({ identity: path.join(root, 'device', 'identity.json'), pending: path.join(root, 'device', 'unbind-pending.json'), credentials: path.join(root, 'remote-credentials.json') })
async function readOptional(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** Revocation is gateway-wide and requires an SSO-authorized device login. */
export function registerDeviceLifecycle({ app, store, authenticate, audit, revoke, onUnbind = () => {} }) {
  app.post('/api/v1/devices/:id/unbind', async req => {
    const id = req.params.id
    if (!idPattern.test(id) || req.body?.confirmation !== id) throw failure('confirmation_required', 'Repeat the exact device id to confirm unbinding', 400)
    const bearer = req.headers.authorization?.replace(/^Bearer /, '')
    if (!bearer) throw failure('device_login_required', 'A local device login is required', 401)
    const receiptKey = `device-unbind-receipt:${hash(`${id}\0${bearer}`)}`
    let receipt = await store.get(receiptKey)
    if (!receipt || receipt.expires <= Date.now()) {
      const auth = await authenticate(req, 'device')
      const device = await store.get(`device:${id}`), tombstone = await store.get(`device-unbound:${id}`)
      const source = tombstone || device
      if (!source || source.owner !== auth.account.id || source.organization !== auth.account.organization) throw failure('owner_required', 'Only the device owner can unbind it', 403)
      // A freshly reauthenticated device login may retire its owner's device
      // without re-exposing old shares first. A credential already bound to a
      // different computer may not do so. This is owner authority, not a claim
      // that an SSO bearer proves physical presence at the computer.
      if (auth.session.deviceId !== id && auth.session.deviceId !== null) throw failure('local_device_required', 'Use a fresh owner device login or the computer being removed', 403)
      receipt = { id, owner: source.owner, organization: source.organization, state: 'pending', expires: Date.now() + 86400000 }
      await store.put(receiptKey, receipt)
    }
    if (receipt.state === 'complete') return { unbound: true, deviceId: id }
    // Tombstone first: interrupted cleanup must never permit a reconnect or RPC.
    await store.put(`device-unbound:${id}`, { id, owner: receipt.owner, organization: receipt.organization, unboundAt: Date.now() })
    await onUnbind(id)
    for (const session of await store.list('identity-session:')) if (session.deviceId === id) await revoke(session.id)
    await store.delete(`device:${id}`)
    await audit('device.unbound', receipt.owner, id)
    await store.put(receiptKey, { ...receipt, state: 'complete' })
    return { unbound: true, deviceId: id }
  })
}

export async function readDeviceLifecycle({ root = userRootDir() } = {}) {
  const files = paths(root)
  return { identity: await readOptional(files.identity), pending: await readOptional(files.pending) }
}

/** Coordinate CLI startup and destructive binding changes across processes. */
export async function acquireDeviceLifecycleLock({ root = userRootDir() } = {}) {
  try { return (await acquireProcessLock(path.join(root, 'remote-lifecycle.lock'))).release }
  catch (error) { if (error.code === 'device_in_use') throw failure('lifecycle_busy', 'A remote hub or binding change is active. Stop it before changing login or ownership'); throw error }
}

/** Account/gateway changes never implicitly inherit this OS user's history. */
export async function acceptRemoteIdentity(credentials, { root = userRootDir(), transferHistory = false, previousCredentials = null } = {}) {
  const lock = transferHistory ? await acquireProcessLock(path.join(root, 'device', 'device.lock')) : null
  try {
  const { identity, pending } = await readDeviceLifecycle({ root })
  if (!identity) return
  if (pending && (pending.owner !== credentials.profile.id || pending.gateway !== credentials.gateway)) throw failure('unbind_pending', 'Finish the pending device unbind with the previous account before changing accounts')
  const owner = identity.owner || identity.historyOwner
  const gateway = identity.ownerGateway || identity.historyGateway || previousCredentials?.gateway
  const organization = identity.profile?.organization || identity.historyOrganization
  const changing = owner && (owner !== credentials.profile.id || gateway && gateway !== credentials.gateway || organization && organization !== credentials.profile.organization)
  if (changing && identity.owner) throw failure('owner_conflict', 'This computer is bound to another account or gateway. Run kkcode remote transfer locally first')
  if (changing && !transferHistory) throw failure('history_transfer_required', 'Local history still belongs to the previous account. Use kkcode remote transfer --include-history with explicit device confirmation')
  if (transferHistory) {
    if (pending) throw failure('unbind_pending', 'Complete the pending unbind before transferring history')
    await writePrivateFile(paths(root).identity, JSON.stringify({ ...identity, historyOwner: credentials.profile.id, historyGateway: credentials.gateway, historyOrganization: credentials.profile.organization, historyTransferAt: Date.now() }))
  }
  } finally { await lock?.release() }
}

export async function prepareRemoteBinding(service, credentials, { root = userRootDir() } = {}) {
  const { pending } = await readDeviceLifecycle({ root })
  if (pending) throw failure('unbind_pending', 'Device unbind is incomplete. Run kkcode remote unbind again before starting remote control')
  await acceptRemoteIdentity(credentials, { root })
  await service.bindOwner(credentials.profile.id, credentials.profile)
  service.metadata.ownerGateway = credentials.gateway
  service.metadata.historyOwner = credentials.profile.id
  service.metadata.historyGateway = credentials.gateway
  service.metadata.historyOrganization = credentials.profile.organization
  await service.saveIdentity()
}

/** Durable two-phase operation: network failure leaves remote exposure blocked. */
export async function unbindLocalDevice({ confirmation, credentials, root = userRootDir(), revokeRemote, clearCredentials } = {}) {
  const lock = await acquireProcessLock(path.join(root, 'device', 'device.lock'))
  try {
  const files = paths(root)
  let { identity, pending } = await readDeviceLifecycle({ root })
  if (!identity) throw failure('device_missing', 'This computer has no remote device identity', 404)
  const deviceId = pending?.deviceId || identity.id
  if (confirmation !== deviceId) throw failure('confirmation_required', 'The confirmation must exactly match the current device id', 400)
  if (!pending && !identity.owner) return { unbound: true, deviceId, nextDeviceId: identity.id, historyRetained: true, alreadyUnbound: true }
  if (!pending) {
    if (!credentials || credentials.profile.id !== identity.owner || identity.ownerGateway && credentials.gateway !== identity.ownerGateway) throw failure('previous_login_required', 'Sign in as the current device owner before unbinding', 401)
    pending = { deviceId, nextDeviceId: randomUUID(), owner: identity.owner, gateway: credentials.gateway, organization: identity.profile?.organization, phase: 'revoking', startedAt: Date.now() }
    await writePrivateFile(files.pending, JSON.stringify(pending))
  }
  if (pending.phase !== 'revoked') {
    if (!credentials || credentials.profile.id !== pending.owner || credentials.gateway !== pending.gateway) throw failure('previous_login_required', 'Sign in as the previous owner to finish unbinding', 401)
    const result = await revokeRemote({ deviceId, credentials })
    if (result?.unbound !== true || result.deviceId !== deviceId) throw failure('unbind_unconfirmed', 'Gateway did not confirm device revocation; local binding is unchanged')
    pending = { ...pending, phase: 'revoked' }
    await writePrivateFile(files.pending, JSON.stringify(pending))
  }
  // Preserve conversations/configuration on disk, but rotate the device namespace
  // so no historical share or request can accidentally attach to a new owner.
  identity = { ...identity, id: pending.nextDeviceId, owner: null, profile: null, ownerGateway: null, historyOwner: pending.owner, historyGateway: pending.gateway, historyOrganization: pending.organization, unboundAt: Date.now() }
  await writePrivateFile(files.identity, JSON.stringify(identity))
  if (clearCredentials) await clearCredentials()
  else await writePrivateFile(files.credentials, 'null')
  await unlink(files.pending)
  return { unbound: true, deviceId, nextDeviceId: identity.id, historyRetained: true }
  } finally { await lock.release() }
}
