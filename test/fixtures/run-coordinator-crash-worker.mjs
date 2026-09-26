import path from 'node:path'
import { createDelegatedKernel } from '../../src/kernel/isolation/delegation-kernel.mjs'
import { createRunCoordinator } from '../../src/kernel/orchestration/run-coordinator.mjs'
import { openRunStore } from '../../src/storage/run-store.mjs'
import { createArtifactStore } from '../../src/storage/artifact-store.mjs'
import { checkpointCrashCoverage } from '../helpers/crash-coverage.mjs'

const [root, cwd, baseUrl] = process.argv.slice(2)
process.on('disconnect', () => process.exit(0))
// An unresolved promise alone does not keep Node alive. The fixture must wait
// for the parent's actual SIGKILL, not race natural exit/coverage finalization.
setInterval(() => {}, 1000)
const configState = { source: { userDir: root, userRaw: { usage: { pricing_file: path.join(root, 'fixture-prices.json') } } }, config: {
  provider: { default: 'fixture', fixture: { type: 'openai', base_url: baseUrl, api_key: '', api_key_env: '', default_model: 'fixture-model', stream: false, timeout_ms: 3000, context_limit: 131072, max_tokens: 1000 } },
  agent: { default_mode: 'agent', max_steps: 3 }, permission: { default_policy: 'allow', rules: [] },
  session: { max_history: 30, recovery: false, title_generation: false }, tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
  usage: { aggregation: ['turn'], budget: {} }, skills: { enabled: false, auto_seed: false }
} }
const kernel = await createDelegatedKernel({ cwd, configState, trustState: { trusted: true }, handlers: { onPermissionPrompt: () => 'allow_once' } })
const store = await openRunStore({ directory: path.join(root, 'runs') })
const artifacts = createArtifactStore({ root: path.join(root, 'artifacts') })
let run
const coordinator = createRunCoordinator({ kernel, store, artifacts, actor: { accountId: 'fixture-account', projectId: 'fixture-project' }, ownerId: 'crash-host', authorize: () => true,
  leaseDirectory: path.join(root, 'leases'), grantDirectory: path.join(root, 'grants'), executionBackend: {
    allowedToolNames: ['write'], ensureReady: async () => ({ strict: true }),
    async executeTool({ invoke }) {
      await invoke()
      checkpointCrashCoverage()
      process.send({ effectApplied: true, runId: run.id })
      return new Promise(() => {})
    }
  }
})
run = await coordinator.start({ limits: { budgetUsd: 10, deadlineAt: Date.now() + 60000 }, contract: { objective: 'Exercise durable crash recovery', allowedPaths: ['.'], requiredCriteria: [{ id: 'checks', description: 'Check actual results' }] } })
await coordinator.execute({ runId: run.id, prompt: 'Create the file once' })
