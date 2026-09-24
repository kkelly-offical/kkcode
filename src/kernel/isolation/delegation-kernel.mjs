import { realpath } from 'node:fs/promises'
import { createKernel } from '../kernel.mjs'
import { loadConfig } from '../../config/load-config.mjs'
import { currentDurableRun } from '../orchestration/run-runtime.mjs'

const delegatedKernels = new WeakSet()
const providerTypes = new Set(['openai', 'openai-compatible', 'anthropic', 'ollama', 'openai-responses', 'gateway'])
const reject = message => { throw Object.assign(new Error(message), { code: 'delegation_kernel_required' }) }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

/** This brand cannot be reconstructed from a model/RPC capability field. */
export function isDelegatedKernel(kernel) { return delegatedKernels.has(kernel) }

/**
 * Dedicated host control plane. Untrusted task code executes only in the backend;
 * provider credentials remain in this process, not in its child environment.
 * @param {Record<string, any>} [options]
 */
export async function createDelegatedKernel(options = {}) {
  if (!options.cwd) reject('委托任务需要明确的独立工作目录。')
  const cwd = await realpath(options.cwd)
  const input = options.configState || options.config || await loadConfig(cwd)
  const state = structuredClone(input)
  if (!state?.config) reject('委托任务缺少经过宿主校验的配置。')
  for (const [name, value] of Object.entries(state.config.provider || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value || 'base_url' in value)) continue
    if (!providerTypes.has(value.type || name)) reject(`严格委托不加载自定义模型实现：${name}`)
  }
  for (const config of [state.config, state.userConfig, state.extensionConfig].filter(Boolean)) {
    // A detached title job must not outlive the host-confirmed task budget.
    config.session = { ...config.session, title_generation: false }
    config.tool = { ...config.tool, sources: { builtin: true, local: false, plugin: false, mcp: false } }
    config.skills = { ...config.skills, enabled: false, auto_seed: false }
    config.mcp = { servers: {} }
    config.plugins = { enabled: false, entries: [] }
    // Host hooks never boot in this kernel, including bundled hooks that spawn a formatter.
  }
  const kernel = Object.assign(/** @type {import('../../sdk/index.mjs').Kernel} */ (await createKernel({ ...options, cwd, configState: state, config: state, boot: false, inheritProviders: false })), {
    bootExtensions: async () => reject('严格委托不允许在宿主进程加载扩展。请使用已验收的受控工具。'),
    applyTrustState: async () => reject('委托期间不能重新引导宿主扩展；请结束任务后在普通会话修改信任设置。')
  })
  const execute = kernel.executeTurn.bind(kernel)
  kernel.executeTurn = input => {
    if (!currentDurableRun()) return Promise.reject(Object.assign(new Error('严格内核只能由持久任务协调器执行，不能退回宿主工具路径。'), { code: 'delegation_context_required' }))
    return execute(input)
  }
  kernel.turns.executeTurn = kernel.executeTurn
  freeze(state)
  delegatedKernels.add(kernel)
  return kernel
}
