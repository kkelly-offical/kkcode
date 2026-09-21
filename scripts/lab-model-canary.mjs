import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { loadLab } from './lab-browser.mjs'
import { loadConfig } from '../src/config/load-config.mjs'
import { createKernel, discoverModelsForProvider } from '../src/kernel/index.mjs'
import { writePrivateFile } from '../src/storage/private-file.mjs'

const original = await loadConfig(process.cwd()), lab = await loadLab()
const providerName = process.env.KKCODE_LAB_PROVIDER || 'kimi-code'
const provider = original.config.provider[providerName]
if (!provider) throw new Error('Choose an existing KK Code provider with KKCODE_LAB_PROVIDER; credentials are never printed')
const cwd = path.join(lab.directory, 'model-canary-workspace'), stateDir = path.join(lab.directory, 'model-canary-state')
await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(stateDir, { recursive: true, mode: 0o700 })
process.env.KKCODE_HOME = stateDir
const configured = { ...provider, max_tokens: 256, timeout_ms: 30000, stream_idle_timeout_ms: 30000, retry_attempts: 0 }
await writePrivateFile(path.join(stateDir, 'config.json'), JSON.stringify({ provider: { default: providerName, [providerName]: configured }, skills: { auto_seed: false }, mcp: { auto_discover: false }, tool: { sources: { builtin: false, local: false, plugin: false, mcp: false } }, agent: { max_steps: 1 } }))
const kernel = await createKernel({ cwd, boot: false, trustState: { trusted: true } })
try {
  const catalog = await kernel.run(() => discoverModelsForProvider(kernel.configState, { providerName, refresh: true, timeoutMs: 15000 })).catch(error => ({ models: [], error: error.reason || error.code || 'discovery_failed' }))
  const model = configured.default_model || catalog.models[0]?.id
  console.log(JSON.stringify({ provider: providerName, model, discoveredModels: catalog.models.map(model => model.id), discoveryError: catalog.error || null }))
  const result = await kernel.executeTurn({ prompt: 'Reply with exactly KKCODE_LAB_OK. Do not call any tools.', sessionId: kernel.turns.newSessionId(), model, providerType: providerName, mode: 'assistant', signal: AbortSignal.timeout(45000) })
  if (!result.reply?.includes('KKCODE_LAB_OK')) throw new Error('Live model response did not satisfy the bounded canary')
  console.log(JSON.stringify({ liveInference: 'passed', provider: providerName, model, usage: result.usage }))
} finally { await kernel.shutdown() }
