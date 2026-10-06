import { encryptedStore } from '../../storage/encrypted-store.mjs'

export const managedMcpStore = (name, reference) => encryptedStore(`managed-mcp:${name}:${reference}`)
export async function resolveManagedMcpConfig(name, config) {
  if (!config?.credential_ref) return config
  if (!/^[0-9a-f-]{36}$/.test(config.credential_ref)) throw new Error('Invalid managed MCP reference')
  const saved = await managedMcpStore(name, config.credential_ref).read()
  if (!saved.config) return { transport: config.transport, enabled: false }
  // Bind the entire endpoint/process to the credentials; a project layer cannot
  // redirect a managed connection while retaining those credentials.
  return { ...saved.config, enabled: config.enabled !== false }
}
