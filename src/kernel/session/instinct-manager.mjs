import { createMemoryController } from './memory-controller.mjs'
import { currentRuntime } from '../core/runtime-context.mjs'

/** Legacy hook facade: repeated model observations only create candidates.
 * Repetition, imported confidence scores and user-looking transcript strings
 * are not a host confirmation and can never activate a preference. */
const view = entry => ({ ...entry, pattern: entry.text, confidence: entry.status === 'active' ? 0.9 : 0,
  observations: 1, lastSeenAt: entry.updatedAt })

export async function addInstinct(cwd, pattern, category = 'workflow') {
  const entry = await createMemoryController({ cwd }).propose({ text: pattern,
    category: ['project-fact', 'workflow', 'preference'].includes(category) ? category : 'workflow',
    sessionId: currentRuntime()?.sessionId })
  return entry.suppressed ? { ...entry, observations: 0, confidence: 0, status: 'forgotten' } : view(entry)
}

export async function listInstincts(cwd, minConfidence = 0) {
  const { entries } = await createMemoryController({ cwd }).list({ scope: 'project' })
  return entries.map(view).filter(entry => entry.confidence >= minConfidence)
}

export async function removeInstinct(cwd, id) {
  const controller = createMemoryController({ cwd })
  try { const entry = await controller.get({ id }); await controller.forget({ id, expectedVersion: entry.version }); return true }
  catch (error) { if (error.code === 'memory_not_found' || error.code === 'memory_invalid_id') return false; throw error }
}

export async function exportInstincts(cwd) {
  const instincts = await listInstincts(cwd)
  return { exportedAt: Date.now(), count: instincts.length, instincts, note: 'Exports are reference data. Import never carries activation or approval.' }
}

export async function importInstincts(cwd, data) {
  if (!data || !Array.isArray(data.instincts)) return { imported: 0, reinforced: 0, rejected: 0 }
  const controller = createMemoryController({ cwd })
  const existing = new Set((await controller.list()).entries.map(entry => entry.id))
  let imported = 0, rejected = 0
  for (const value of data.instincts.slice(0, 500)) {
    try {
      const entry = await controller.propose({ text: value?.pattern, category: 'workflow' })
      if (!entry.suppressed && !existing.has(entry.id)) { imported++; existing.add(entry.id) }
    } catch { rejected++ }
  }
  return { imported, reinforced: 0, rejected }
}

export async function formatInstinctsForPrompt(cwd, _minConfidence = 0.5) {
  return createMemoryController({ cwd }).formatForPrompt()
}
