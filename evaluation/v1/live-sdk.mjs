import path from 'node:path'
import { mkdir, writeFile, realpath, lstat } from 'node:fs/promises'
import { createRunCoordinator, createDelegatedKernel, createDockerExecutionBackend, openRunStore, createArtifactStore } from '../../src/sdk/runs.mjs'
import { createOfficeService } from '../../src/sdk/office.mjs'
import { loadConfig } from '../../src/config/load-config.mjs'
import { sha256 } from './manifest.mjs'
import { runRecoveryScenario, supportedRecovery } from './recovery-drivers.mjs'

export function validateLiveProfile(profile) {
  const keys = ['providerType', 'model', 'baseUrl', 'apiKeyEnv', 'contextLimit', 'maxTokens', 'pricing', 'maxSteps']
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some(key => !keys.includes(key))) throw new Error('Live profile contains unknown fields; inline credentials are forbidden')
  if (!['openai', 'anthropic', 'responses', 'ollama'].includes(profile.providerType) || typeof profile.model !== 'string' || !profile.model) throw new Error('Explicit provider and model required')
  const url = new URL(profile.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Provider URL must not contain credentials, query or fragment')
  const authlessLocal = profile.apiKeyEnv === null && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!authlessLocal && (!/^[A-Z][A-Z0-9_]{1,100}$/.test(profile.apiKeyEnv || '') || !process.env[profile.apiKeyEnv])) throw new Error('Set the explicitly selected API key environment variable, or explicitly choose null for an authless loopback endpoint')
  if (url.protocol !== 'https:' && !authlessLocal) throw new Error('Credentials require HTTPS; plaintext HTTP is supported only for an explicitly authless loopback fixture')
  if (![profile.contextLimit, profile.maxTokens].every(value => Number.isSafeInteger(value) && value > 0) || profile.maxTokens >= profile.contextLimit) throw new Error('Explicit bounded model context/output limits required')
  if (!profile.pricing || Object.keys(profile.pricing).sort().join(',') !== 'cache_read,cache_write,input,output'
    || Object.values(profile.pricing).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Complete USD per-million input/output/cache_read/cache_write prices required')
  if (profile.maxSteps !== undefined && (!Number.isSafeInteger(profile.maxSteps) || profile.maxSteps < 1 || profile.maxSteps > 100)) throw new Error('Invalid step ceiling')
  return structuredClone(profile)
}

export { supportedRecovery }

/** Real SDK entrypoint, never a generated-answer/mock fallback. Budget is stored
 * by the coordinator before any provider request and is shared across resumes. */
export async function runLiveTask({ task, cwd, privateRoot, profile, image, officeImage, budgetUsd, deadlineAt, signal }) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw new Error('Live evaluation requires an explicit positive budget and future absolute deadline')
  if (task.driver === 'durable-recovery') return runRecoveryScenario({ task, cwd, privateRoot, profile, image, budgetUsd, deadlineAt, signal, mode: 'live' })
  const relativeControl = path.relative(path.resolve(cwd), path.resolve(privateRoot))
  if (!relativeControl || !path.isAbsolute(relativeControl) && relativeControl !== '..' && !relativeControl.startsWith(`..${path.sep}`)) throw new Error('Evaluation control state and prices must stay outside the model workspace')
  await mkdir(privateRoot, { recursive: true, mode: 0o700 })
  if ((await lstat(privateRoot)).isSymbolicLink()) throw new Error('Evaluation control directory must not be an alias')
  const canonicalControl = await realpath(privateRoot), canonicalWorkspace = await realpath(cwd)
  const actualRelative = path.relative(canonicalWorkspace, canonicalControl)
  if (!actualRelative || !path.isAbsolute(actualRelative) && actualRelative !== '..' && !actualRelative.startsWith(`..${path.sep}`)) throw new Error('Evaluation control state resolved inside the model workspace')
  privateRoot = canonicalControl
  const previousHome = process.env.KKCODE_HOME
  let store, kernel, coordinator, office
  const operations = [], turnEvidence = []
  process.env.KKCODE_HOME = path.join(privateRoot, 'state')
  try {
  await mkdir(process.env.KKCODE_HOME, { mode: 0o700, recursive: true })
  const pricingFile = path.join(process.env.KKCODE_HOME, 'evaluation-pricing.json')
  await writeFile(pricingFile, JSON.stringify({ currency: 'USD', per_tokens: 1000000, models: { [profile.model]: profile.pricing } }), { flag: 'wx', mode: 0o600 })
  const config = {
    provider: { default: 'evaluation', evaluation: { type: profile.providerType === 'responses' ? 'openai-responses' : profile.providerType, base_url: profile.baseUrl, api_key: '', api_key_env: profile.apiKeyEnv || '',
      default_model: profile.model, context_limit: profile.contextLimit, max_tokens: profile.maxTokens, stream: true } },
    agent: { default_mode: 'agent', max_steps: profile.maxSteps || 40 },
    session: { title_generation: false, recovery: false },
    usage: { pricing_file: pricingFile },
    permission: { level: 'accept-edits', rules: [] },
    tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
    skills: { enabled: false, auto_seed: false }, plugins: { enabled: false }, mcp: { servers: {} }
  }
  await writeFile(path.join(process.env.KKCODE_HOME, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    const state = await loadConfig(cwd)
    if (state.errors?.length) throw Object.assign(new Error('Evaluation host configuration failed schema validation'), { details: state.errors })
    if (state.config.provider.default !== 'evaluation' || state.config.provider.evaluation.api_key) throw new Error('Ambient configuration altered the explicitly selected provider')
    const effective = structuredClone(state.config)
    effective.usage.pricing_file = '<private-evaluation-prices>'
    const stateFingerprint = sha256(effective)
    store = await openRunStore({ directory: path.join(privateRoot, 'runs') })
    const artifacts = createArtifactStore({ root: path.join(privateRoot, 'artifacts') })
    if (task.driver === 'office-document') office = await createOfficeService({ cwd, image: officeImage })
    const construct = async () => {
      kernel = await createDelegatedKernel({ cwd, configState: state, trustState: { trusted: true }, services: office ? { office } : {} })
      coordinator = createRunCoordinator({ kernel, store, artifacts, actor: { accountId: 'evaluation', projectId: task.id },
        ownerId: `evaluation-${task.id}-${turnEvidence.length}`, executionBackend: createDockerExecutionBackend({ image: task.driver === 'office-document' ? officeImage : image }),
        leaseDirectory: path.join(privateRoot, 'leases'), grantDirectory: path.join(privateRoot, 'grants'),
        authorize: request => ['run.contract', 'run.takeover', 'run.tool'].includes(request.kind) && request.kind !== 'run.action' })
    }
    await construct()
    const contract = { objective: task.prompt, allowedPaths: ['.'],
      allowedTools: ['read', 'write', 'edit', 'patch', 'list', 'bash', 'todowrite', 'artifact_read', 'artifact_search',
        ...(office ? ['office_capabilities', 'office_inspect', 'office_create', 'office_edit', 'office_render', 'office_pdf', 'office_ocr'] : [])],
      allowedExternalActions: [], requiredCriteria: [{ id: 'benchmark-independent-oracle', description: 'Private benchmark oracle must inspect actual candidate; model prose cannot complete' }] }
    const started = await coordinator.start({ contract, limits: { budgetUsd, deadlineAt } })
    const first = await coordinator.execute({ runId: started.id, prompt: task.prompt, model: profile.model, providerType: 'evaluation', mode: 'agent', signal })
    turnEvidence.push({ status: first.run.state, toolEvents: first.turn.toolEvents, error: !!first.turn.error, diagnostic: first.turn.error || null })
    const beforeEventsHash = sha256(await store.events({ runId: started.id })), lifecycleReceipt = null
    const run = await coordinator.inspect(started.id), events = await store.events({ runId: started.id })
    return { durableRunId: run.id, ownerEpoch: String(run.ownerEpoch), beforeEventsHash, afterEventsHash: sha256(events),
      lifecycle: task.lifecycle, lifecycleReceipt, actions: run.actions, operations, budget: await store.getRunBudget({ runId: run.id }),
      stateFingerprint, modelError: turnEvidence.some(turn => turn.error), turnsHash: sha256(turnEvidence), runState: run.state,
      diagnostics: turnEvidence.map(turn => turn.diagnostic).filter(Boolean) }
  } finally {
    try {
      try { await coordinator?.close() } finally { try { await kernel?.shutdown() } finally { await office?.dispose(); await store?.close() } }
    } finally { if (previousHome === undefined) delete process.env.KKCODE_HOME; else process.env.KKCODE_HOME = previousHome }
  }
}
