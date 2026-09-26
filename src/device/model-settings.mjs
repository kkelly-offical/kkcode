import path from 'node:path'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
import { loadConfig } from '../config/load-config.mjs'
import { validateConfig } from '../config/schema.mjs'
import { DEFAULT_CONFIG } from '../config/defaults.mjs'
import { configurationDiagnostics, configurationErrorMessage } from '../config/diagnostics.mjs'
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
    // The basic connection form only requires Base URL + key. Default the
    // omitted protocol to OpenAI-compatible (vLLM etc.); explicit Anthropic or
    // other supported protocol selections still take precedence.
    // An explicit form key (including an intentionally empty one) must not
    // silently borrow OPENAI_API_KEY from the host's environment.
    state.config.provider = { ...state.config.provider, [name]: { type: 'openai-compatible', ...(typeof connection.api_key === 'string' && connection.api_key_env === undefined ? { api_key_env: '' } : {}), ...connection } }
    const validation = validateConfig(state.config)
    if (!validation.valid) throw new ProtocolError('invalid_config', validation.errors.join('; '))
  }
  let catalog
  try { catalog = await discoverModelsForProvider(state, { providerName: name, refresh: params.refresh !== false }) }
  catch (error) {
    if (error.details?.reason === 'insecure_transport') throw new ProtocolError('insecure_provider_transport', '不能向明文 HTTP 发送模型凭据。请使用 HTTPS；无认证的本地服务请移除 API Key 并显式设置 api_key_env 为 ""。', 422)
    if (error.details?.reason === 'workspace_untrusted') throw new ProtocolError('workspace_untrusted', '项目配置控制了模型连接。请先在被控电脑检查该配置，并对工作区执行 kkcode --trust 或 /trust。', 403)
    const reason = error.details?.reason, status = error.details?.status
    if (reason === 'unknown_provider') throw new ProtocolError('unknown_provider', '当前电脑没有配置所选模型渠道。请在这台电脑的“模型与渠道”中选择或添加渠道；其他设备的配置不会自动套用到这里。', 422)
    if (reason === 'auth') throw new ProtocolError('provider_auth', '模型服务拒绝认证或尚未配置 API Key。请检查当前电脑上该渠道的密钥与权限；这不是 SSH 密码或网关登录失效。', 422)
    if (reason === 'invalid_config') throw new ProtocolError('invalid_provider_config', '模型渠道配置不完整或 Base URL 无效。请检查当前电脑的地址、协议与接口路径，地址中不能夹带账号密码。', 422)
    if (reason === 'unsupported_protocol' || reason === 'model_catalog_unavailable') throw new ProtocolError('model_catalog_unavailable', '该渠道未启用模型目录，或不支持 OpenAI/Anthropic 模型列表接口。可启用自动发现，或在渠道配置中手动填写模型 ID。', 422)
    if (reason === 'unsafe_redirect') throw new ProtocolError('provider_redirect_denied', '模型目录接口跳转到了另一个站点，已阻止发送凭据。请把 Base URL 改为可信的最终服务地址。', 422)
    if (reason === 'bad_response') throw new ProtocolError('model_catalog_invalid', status === 404
      ? '模型目录接口不存在（HTTP 404）。请核对 Base URL 是否需要 /v1，且不要重复填写 /models；也可以手动填写模型 ID。'
      : `模型服务返回的目录无法读取${Number.isInteger(status) ? `（HTTP ${status}）` : ''}。请确认 Base URL 指向模型 API，而不是登录页或网页；若接口不支持模型列表，可以手动填写模型 ID。`, 422)
    if (['TimeoutError', 'AbortError'].includes(error.name) || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code || error.code) || error.message === 'fetch failed') {
      throw new ProtocolError('provider_unreachable', '被控电脑无法连接模型服务或请求超时。请从那台电脑检查 Base URL、端口、防火墙与服务状态；localhost / 127.0.0.1 指向被控电脑自身，SSH 连接不会自动转发手机或另一台电脑上的模型服务。', 422)
    }
    throw error
  }
  // Every entry declares its provenance: auto-discovered from the provider
  // (network/disk cache) or the manually maintained config fallback list. Newer
  // kernels already mark entries; fill the marker on older ones.
  const origin = catalog.source === 'config' ? 'manual' : 'auto'
  return { ...catalog, models: catalog.models.map(model => {
    const discovered = parseCatalogEntryCapabilities(model) || {}
    const configured = normalizeCapabilities(state.config.provider.model_capabilities?.[model.id])
    const capabilities = { ...inferCapabilitiesFromName(model.id), ...discovered, ...configured }
    const capabilitySources = Object.fromEntries(Object.keys(capabilities).map(key => [key, key in configured ? 'config' : key in discovered ? 'discovered' : 'heuristic']))
    if (catalog.protocol !== 'openai') for (const key of ['audio', 'video']) { capabilities[key] = false; capabilitySources[key] = 'protocol' }
    return { origin, ...model, capabilities, capabilitySources }
  }) }
}
export async function updateDeviceSettings(service, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProtocolError('invalid_config', 'config object required')
  if (Object.hasOwn(patch, '_diagnostics') || Object.hasOwn(patch.permission || {}, '_load_error')) throw new ProtocolError('invalid_config', '配置诊断是只读信息，不能通过保存配置清除安全限制')
  if (service.turns.size) throw new ProtocolError('configuration_busy', 'Wait for running turns to finish before changing device configuration', 409)
  const loaded = await loadConfig(service.cwd)
  const validation = validateConfig(merge(loaded.config, patch))
  if (!validation.valid) throw new ProtocolError('invalid_config', configurationErrorMessage(validation.errors))
  const file = loaded.source.userPath || path.join(userRootDir(), 'config.json')
  let original = {}
  try { const raw = await readFile(file, 'utf8'); original = file.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw) || {} }
  catch (error) { if (error.code !== 'ENOENT') throw new ProtocolError('invalid_config', '配置未保存：无法读取或解析原有用户配置。请在被控电脑修正文件后重试；原文件未修改。') }
  if (!original || typeof original !== 'object' || Array.isArray(original)) throw new ProtocolError('invalid_config', configurationErrorMessage([]))
  const next = merge(original, patch)
  // Validate the bytes that will actually be saved, not only a sanitized
  // effective view which may have discarded an existing malformed subtree.
  const persisted = validateConfig(merge(DEFAULT_CONFIG, next))
  if (!persisted.valid) throw new ProtocolError('invalid_config', configurationErrorMessage(persisted.errors))
  await writePrivateFile(file, file.endsWith('.json') ? JSON.stringify(next, null, 2) + '\n' : YAML.stringify(next))
  for (const [cwd, promise] of service.kernels) {
    const kernel = await promise, fresh = await loadConfig(cwd)
    Object.assign(kernel.configState, fresh)
    await kernel.applyTrustState(kernel.trustState)
  }
  service.emit('configuration', { updated: true })
  return { saved: true, restartRequired: false, config: await deviceSettingsSnapshot(service.cwd) }
}

export async function deviceSettingsSnapshot(cwd) {
  const state = await loadConfig(cwd)
  return { ...redactConfig(state.config), _diagnostics: configurationDiagnostics(state) }
}
