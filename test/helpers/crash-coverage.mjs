import { takeCoverage, stopCoverage } from 'node:v8'

/** Test-only checkpoint at the exact crash boundary, before notifying the
 * parent to SIGKILL. Preserve the executed code's counters, then stop further
 * collection so forced termination cannot interrupt a later coverage write.
 * This never closes a store, settles an action or runs application cleanup.
 */
export function checkpointCrashCoverage() {
  if (!process.env.NODE_V8_COVERAGE) return false
  takeCoverage()
  stopCoverage()
  return true
}
