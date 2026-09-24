import { readFile } from 'node:fs/promises'
import { openRunStore } from '../../src/storage/run-store.mjs'
import { createArtifactStore } from '../../src/storage/artifact-store.mjs'
import { createDelegatedKernel } from '../../src/kernel/isolation/delegation-kernel.mjs'
import { createRunCoordinator } from '../../src/kernel/orchestration/run-coordinator.mjs'

const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
const store = await openRunStore({ directory: input.directory })
const kernel = await createDelegatedKernel({ cwd: input.cwd, configState: input.configState, trustState: { trusted: true } })
const coordinator = createRunCoordinator({ kernel, store, artifacts: createArtifactStore({ root: input.artifacts }), actor: input.actor, ownerId: `worker-${process.pid}`,
  authorize: () => ({ actorId: 'fixture', reason: 'Controlled local HTTP fixture only' }), executionBackend: { allowedToolNames: [], ensureReady: async () => ({ strict: true }), executeTool: () => { throw new Error('fixture forbids tools') } } })
try {
  let run
  try { run = await store.getRun('durable-model-request') } catch (error) { if (error.code !== 'RUN_NOT_FOUND') throw error }
  if (run) await coordinator.attach({ runId: run.id, expectedRevision: run.revision })
  else run = await coordinator.start({ id: 'durable-model-request', limits: input.limits, contract: { objective: 'Wait for controlled HTTP response', allowedPaths: [], allowedTools: [], requiredCriteria: [{ id: 'observe', description: 'Host inspects reply' }] } })
  const result = await coordinator.execute({ runId: run.id, prompt: 'One fixture request; never retry an unknown bill.' })
  process.send?.({ type: 'result', code: result.turn?.error || null })
} catch (error) {
  process.send?.({ type: 'result', code: error.code || error.name })
} finally {
  await coordinator.close(); await kernel.shutdown(); await store.close(); process.disconnect?.()
}
