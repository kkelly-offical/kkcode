// Explicit opt-in real-model acceptance. Run on the device that owns the
// provider configuration; credentials never leave it or enter the receipt.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

if (!process.env.KKCODE_CANARY_PROVIDER) throw new Error('Set KKCODE_CANARY_PROVIDER to explicitly opt into three bounded real-model requests')
const install = process.env.KKCODE_CANARY_INSTALL || fileURLToPath(new URL('../', import.meta.url))
const local = relative => import(pathToFileURL(path.join(install, relative)).href)
const { loadConfig } = await local('src/config/load-config.mjs')
const { createKernel, discoverModelsForProvider, requestProvider } = await local('src/kernel/index.mjs')
const { reviewSensitiveAction } = await local('src/kernel/permission/auto-review.mjs')
const original = await loadConfig(process.cwd()), providerName = process.env.KKCODE_CANARY_PROVIDER
const connection = original.config.provider?.[providerName]
if (!connection) throw new Error('Requested provider is not configured on this device')
const root = await mkdtemp(path.join(os.tmpdir(), 'kkcode-102-model-')), previous = process.env.KKCODE_HOME
const workspace = path.join(root, 'workspace'), state = path.join(root, 'state')
await mkdir(workspace, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
process.env.KKCODE_HOME = state
const config = { provider: { ...original.config.provider, default: providerName, [providerName]: { ...connection, stream: false, retry_attempts: 0, timeout_ms: 40000, thinking_effort: 'off' } }, skills: { auto_seed: false }, mcp: { auto_discover: false }, session: { title_generation: false }, updates: { enabled: false } }
await writeFile(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 })
let kernel
try {
  kernel = await createKernel({ cwd: workspace, trustState: { trusted: true } })
  const catalog = await kernel.run(() => discoverModelsForProvider(kernel.configState, { providerName, refresh: true, timeoutMs: 15000 }))
  assert.equal(catalog.source, 'network', 'Discovery must come from the configured endpoint, not a local/cache fallback')
  const model = connection.default_model || catalog.models[0]?.id
  assert.ok(model && catalog.models.some(item => item.id === model), 'Configured model must be discoverable from the Base URL')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#ff0000"/></svg>'
  await writeFile(path.join(workspace, 'probe.svg'), svg)
  const read = await kernel.tools.get('read')
  const ctx = { cwd: workspace, sessionId: 'canary', config: kernel.configState.config }
  const source = await kernel.run(() => read.execute({ path: 'probe.svg' }, ctx))
  assert.ok(JSON.stringify(source).includes('<svg'))
  const preview = await kernel.run(() => read.execute({ path: 'probe.svg', view: 'image' }, ctx))
  assert.match(preview.data, /^data:image\/png;base64,/)
  const request = messages => kernel.run(() => requestProvider({ configState: kernel.configState, providerType: providerName, model, sessionId: 'canary', system: 'Answer the user concisely. Do not use tools.', messages, tools: [], maxTokens: 256, signal: AbortSignal.timeout(45000) }))
  const vision = await request([{ role: 'user', content: [{ type: 'image', data: Buffer.from(svg).toString('base64'), mediaType: 'image/svg+xml' }] }, { role: 'user', content: 'What single color fills the previous image? Answer with only the English color name.' }])
  assert.match(vision.text, /\bred\b|红/i)
  const recovered = await request([{ role: 'user', content: [{ type: 'image', data: 'QUJD', mediaType: 'image/png' }] }, { role: 'user', content: 'Ignore the unavailable old attachment. Reply exactly KKCODE_HISTORY_OK.' }])
  assert.ok(recovered.text.includes('KKCODE_HISTORY_OK'))
  const review = await kernel.run(() => reviewSensitiveAction({ configState: kernel.configState, providerType: providerName, model, sessionId: 'canary', turnId: 'review', prompt: 'Run npm test in this isolated test workspace to validate the requested implementation.', action: { tool: 'bash', command: 'npm test', workspace }, signal: AbortSignal.timeout(35000) }))
  assert.equal(review.decision, 'allow', 'The model must return a valid scoped review verdict for this canary')
  console.log(JSON.stringify({ model, discoverySource: catalog.source, discovered: catalog.models.map(item => item.id), svgSource: 'passed', svgRasterPreview: 'passed', historicalSvgVision: 'passed', corruptHistoryRecovery: 'passed', sameModelAutoReview: 'passed', requests: 3 }))
} catch (error) {
  console.error(JSON.stringify({ realModelCanary: 'failed', category: error.code || error.reason || error.name || 'unknown' }))
  process.exitCode = 1
} finally {
  await kernel?.shutdown()
  if (previous === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previous
  await rm(root, { recursive: true, force: true })
}
