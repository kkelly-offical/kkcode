/** One precedence/normalization contract for loading and install authorization. */
export function normalizePluginCapabilities(manifest) {
  const caps = manifest.capabilities && typeof manifest.capabilities === 'object' && !Array.isArray(manifest.capabilities) ? manifest.capabilities : {}
  const raw = caps.allowedAgentPermissions || caps.allowed_agent_permissions || manifest.allowedAgentPermissions || manifest.allowed_agent_permissions || ['default']
  const permissions = (Array.isArray(raw) ? raw : [raw]).flatMap(value => typeof value === 'string' ? value.split(',') : [])
    .map(value => value.trim()).filter(Boolean)
  return { allowedAgentPermissions: permissions.length ? permissions : ['default'] }
}
