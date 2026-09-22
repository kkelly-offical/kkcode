import path from 'node:path'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
import { loadConfig } from '../config/load-config.mjs'
import { validateConfig } from '../config/schema.mjs'
import { redactConfig } from '../config/redact.mjs'
import { userRootDir } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { discoverModelsForProvider, inferCapabilitiesFromName, normalizeCapabilities, parseCatalogEntryCapabilities } from '../kernel/index.mjs'
import { ProtocolError } from '../protocol/index.mjs'

function merge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ProtocolError('invalid_config', 'Unsafe configuration key')
    if (value === '[REDACTED]') continue
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key], value) : value
  }
  return out
}
export async function discoverDeviceModels(service, params) {
  const state = await loadConfig(service.cwd)
  let name = params.provider || state.config.provider.default
  if (params.connection) {
    name = '__device_preview__'
    const connection = params.connection
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new ProtocolError('invalid_config', 'connection object required')
    const allowed = ['type', 'protocol', 'base_url', 'api_key', 'api_key_env', 'endpoints', 'default_model']
    if (Object.keys(connection).some(key => !allowed.includes(key))) throw new ProtocolError('invalid_config', 'Unsupported connection field')
    state.config.provider = { ...state.config.provider, [name]: connection }
    const validation = validateConfig(state.config)
    if (!validation.valid) throw new ProtocolError('invalid_config', validation.errors.join('; '))
  }
  const catalog = await discoverModelsForProvider(state, { providerName: name, refresh: params.refresh !== false })
  // Every entry declares its provenance: auto-discovered from the provider
  // (network/disk cache) or the manually maintained config fallback list. Newer
  // kernels already mark entries; fill the marker on older ones.
  const origin = catalog.source === 'config' ? 'manual' : 'auto'
  return { ...catalog, models: catalog.models.map(model => {
    const discovered = parseCatalogEntryCapabilities(model) || {}
    const configured = normalizeCapabilities(state.config.provider.model_capabilities?.[model.id])
    const capabilities = { ...inferCapabilitiesFromName(model.id), ...discovered, ...configured }
    const capabilitySources = Object.fromEntries(Object.keys(capabilities).map(key => [key, key in configured ? 'config' : key in discovered ? 'discovered' : 'heuristic']))
    return { origin, ...model, capabilities, capabilitySources }
  }) }
}
export async function updateDeviceSettings(service, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProtocolError('invalid_config', 'config object required')
  if (service.turns.size) throw new ProtocolError('configuration_busy', 'Wait for running turns to finish before changing device configuration', 409)
  const loaded = await loadConfig(service.cwd)
  const validation = validateConfig(merge(loaded.config, patch))
  if (!validation.valid) throw new ProtocolError('invalid_config', validation.errors.join('; '))
  const file = loaded.source.userPath || path.join(userRootDir(), 'config.json')
  let original = {}
  try { const raw = await readFile(file, 'utf8'); original = file.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw) || {} } catch (error) { if (error.code !== 'ENOENT') throw error }
  const next = merge(original, patch)
  await writePrivateFile(file, file.endsWith('.json') ? JSON.stringify(next, null, 2) + '\n' : YAML.stringify(next))
  for (const [cwd, promise] of service.kernels) {
    const kernel = await promise, fresh = await loadConfig(cwd)
    Object.assign(kernel.configState, fresh)
    await kernel.applyTrustState(kernel.trustState)
  }
  service.emit('configuration', { updated: true })
  return { saved: true, restartRequired: false, config: redactConfig((await loadConfig(service.cwd)).config) }
}
