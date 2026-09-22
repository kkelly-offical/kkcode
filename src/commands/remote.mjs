import { Command } from 'commander'
import { loginRemote, loadRemoteCredentials, saveRemoteCredentials, connectRelay, createRemoteDevice, refreshRemoteCredentials, revokeRemoteDevice, requestGateway } from '../remote/client.mjs'
import { acquireDeviceLifecycleLock, prepareRemoteBinding, readDeviceLifecycle, unbindLocalDevice } from '../remote/device-lifecycle.mjs'
import { createRemoteControl, requestRemoteControl } from '../remote/local-control.mjs'
import { startRepl } from '../repl.mjs'
import path from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { createDeviceServer } from '../device/server.mjs'
import { createInterface } from 'node:readline/promises'
import { chooseRemoteFolderAccess } from '../remote/folder-access.mjs'
import { grantRemoteWorkspaceTrust } from '../remote/workspace-access.mjs'

const statusFile = () => path.join(userRootDir(), 'remote-status.json')
async function liveStatus() {
  try {
    const status = JSON.parse(await readFile(statusFile(), 'utf8'))
    const response = await requestRemoteControl(status.control || {}, 'status')
    return response.pid === status.pid ? status : null
  } catch { return null }
}
async function withStoppedDevice(operation) {
  if (await liveStatus()) throw new Error('Stop the foreground remote hub with kkcode remote stop before changing login or ownership.')
  const release = await acquireDeviceLifecycleLock()
  try { return await operation() } finally { await release() }
}
async function confirmDevice(options, operation) {
  const { identity, pending } = await readDeviceLifecycle()
  const id = pending?.deviceId || identity?.id
  if (!id) throw new Error('No remote device identity exists on this computer.')
  console.error(`${operation}: revoke the old device, its shares and device logins. Local conversations, files and model configuration are retained.`)
  let confirmation = options.confirm
  if (!confirmation && process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stderr })
    try { confirmation = await input.question(`Type device id ${id} to confirm: `) } finally { input.close() }
  }
  if (confirmation !== id) throw new Error(`Explicit confirmation required: --confirm ${id}`)
  return confirmation
}
async function unbindStoppedDevice(confirmation) {
  let credentials = await loadRemoteCredentials()
  const { pending, identity } = await readDeviceLifecycle()
  // Pending operations replay their original bearer receipt before refreshing;
  // the gateway may already have revoked that bearer after a lost response.
  if (!pending && identity?.owner && credentials?.expiresAt < Date.now() + 60000) credentials = await refreshRemoteCredentials(credentials, { signal: AbortSignal.timeout(15000) })
  return unbindLocalDevice({ confirmation, credentials, revokeRemote: revokeRemoteDevice, clearCredentials: () => saveRemoteCredentials(null) })
}

export function createRemoteCommand() {
  const command = new Command('remote').description('Foreground remote control with organization login').option('--gateway <url>', 'Relay gateway URL').option('--trust', 'Trust the current workspace (not a folder-access grant)').option('--trust-all-workspaces', 'Persistently trust project configs/extensions under all authorized roots (tool approvals remain)').option('--root <path>', 'Explicitly grant remote folder access to this root').option('--all-folders', 'Explicitly trust remote access to all OS-accessible ordinary folders').option('--home-only', 'Explicitly grant only the OS user home').option('--web', 'Also serve a paired loopback WebUI using the same kernel').option('--port <port>', 'Loopback WebUI port', '18271')
  command.command('login').option('--gateway <url>').action(async options => withStoppedDevice(async () => { const identity = await loginRemote({ gateway: options.gateway || command.opts().gateway }); console.log(`Signed in: ${identity.profile.name} · ${identity.profile.organization}`) }))
  command.command('status').action(async () => {
    const identity = await loadRemoteCredentials()
    const runtime = await liveStatus()
    const local = await readDeviceLifecycle()
    const binding = { deviceId: local.pending?.deviceId || local.identity?.id || null, bound: Boolean(local.identity?.owner), unbindPending: Boolean(local.pending), retainedHistoryOwner: local.identity?.historyOwner || local.identity?.owner || null }
    console.log(JSON.stringify(identity ? { loggedIn: true, gateway: identity.gateway, profile: identity.profile, credentialExpired: identity.expiresAt < Date.now(), running: Boolean(runtime), connection: runtime?.connection || 'offline', folderAccess: runtime?.folderAccess || null, roots: runtime?.roots || [], startupWorkspaceTrustRoots: runtime?.startupWorkspaceTrustRoots || [], ...binding } : { loggedIn: false, running: Boolean(runtime), ...binding }, null, 2))
  })
  command.command('stop').description('Stop this user’s foreground remote hub without signing out').action(async () => {
    const runtime = await liveStatus()
    if (!runtime) { console.log('Remote is already offline'); return }
    await requestRemoteControl(runtime.control, 'stop')
    console.log('Remote stop requested; the foreground terminal is shutting down.')
  })
  command.command('logout').description('Revoke this local device login; keeps device ownership and local history').action(async () => withStoppedDevice(async () => {
    let identity = await loadRemoteCredentials()
    if (identity) {
      if (identity.expiresAt < Date.now() + 60000) identity = await refreshRemoteCredentials(identity, { signal: AbortSignal.timeout(15000) })
      const response = await requestGateway(identity.gateway, '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.access_token}` }, body: JSON.stringify({ kind: 'device' }), signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`Gateway could not confirm logout (HTTP ${response.status}). Credentials retained for a safe retry.`)
      await saveRemoteCredentials(null)
    }
    console.log('Signed out')
  }))
  command.command('unbind').description('Locally revoke this device and all shares; keep local history private').option('--confirm <device-id>', 'Repeat the device id shown by remote status').action(async options => withStoppedDevice(async () => {
    const result = await unbindStoppedDevice(await confirmDevice(options, 'Unbind device'))
    console.log(`Device unbound. Local history retained; new device id: ${result.nextDeviceId}`)
  }))
  command.command('transfer').description('Explicitly transfer this computer and retained local history to another SSO account').option('--gateway <url>', 'New account gateway URL').option('--confirm <device-id>', 'Repeat the current device id').option('--include-history', 'Consent to the new account accessing retained history, allowed folders and model configuration').action(async options => withStoppedDevice(async () => {
    if (!options.includeHistory) throw new Error('Transfer requires --include-history. The new owner can access retained conversations, allowed folders and model configuration. Use a separate OS user/KKCODE_HOME for an isolated account instead.')
    const previous = await loadRemoteCredentials(), local = await readDeviceLifecycle()
    const gateway = options.gateway || command.opts().gateway || previous?.gateway || local.identity?.historyGateway
    const confirmation = await confirmDevice(options, 'Transfer device and retained history')
    await unbindStoppedDevice(confirmation)
    const credentials = await loginRemote({ gateway, transferHistory: true })
    const service = await createRemoteDevice()
    try { await prepareRemoteBinding(service, credentials) } finally { await service.close() }
    console.log(`Transferred to ${credentials.profile.name} · ${credentials.profile.organization}. Run kkcode remote to expose the new private device; previous shares are not copied.`)
  }))
  command.action(async options => {
    if (await liveStatus()) throw new Error('A remote hub is already running for this user. Use kkcode remote status or stop it first.')
    const release = await acquireDeviceLifecycleLock()
    try {
    const folderAccess = await chooseRemoteFolderAccess(options)
    let credentials = await loadRemoteCredentials()
    if (!credentials || (options.gateway && credentials.gateway !== options.gateway)) credentials = await loginRemote({ gateway: options.gateway })
    const service = await createRemoteDevice({ roots: folderAccess.roots })
    let startupWorkspaceTrustRoots = []
    let relay, web, control, closing = false
    const updateStatus = async () => writePrivateFile(statusFile(), JSON.stringify({ pid: process.pid, deviceId: service.metadata.id, gateway: credentials.gateway, profile: credentials.profile, connection: service.remoteStatus || 'connecting', folderAccess: folderAccess.mode, roots: service.roots, startupWorkspaceTrustRoots, control: control ? { endpoint: control.endpoint, token: control.token } : null, updatedAt: Date.now() }))
    const close = async () => {
      if (closing) return; closing = true
      clearInterval(heartbeat)
      try {
        relay?.close()
        try { await web?.close() } finally { await service.close() }
      } finally {
        await control?.close()
        await unlink(statusFile()).catch(() => {})
        await release()
      }
    }
    const heartbeat = setInterval(() => { if (!closing) void updateStatus().catch(() => {}) }, 10000); heartbeat.unref()
    const stop = () => { void close().finally(() => process.exit(0)) }
    process.once('SIGTERM', stop); process.once('SIGHUP', stop)
    try {
      startupWorkspaceTrustRoots = await grantRemoteWorkspaceTrust(service.roots, { enabled: options.trustAllWorkspaces })
      if (startupWorkspaceTrustRoots.length) console.error('已按本机操作者的明确授权，递归信任允许目录中的项目配置与扩展；工具审批和凭据路径保护保持不变。')
      control = await createRemoteControl({ onStop: stop })
      relay = await connectRelay({ service, credentials, onStatus: status => { service.remoteStatus = status; if (!closing) void updateStatus().catch(() => {}) } })
      await updateStatus()
      if (options.web) {
        const port = Number(options.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WebUI port')
        web = await createDeviceServer({ service, port }); const local = await web.listen()
        console.error(`Local WebUI: ${local.url}`)
      }
      console.error(`Remote: ${credentials.profile.name} · ${credentials.profile.organization} · ${credentials.gateway}\nRemote access ends when this terminal exits.`)
      await startRepl({ trust: options.trust, remoteService: service })
    }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop); await close() }
    } finally { await release() }
  })
  return command
}
