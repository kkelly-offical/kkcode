import { getSession, listSessions } from "./store.mjs"
import { listRecoverableSessions } from "./recovery.mjs"
import { auditStats } from "../storage/audit-store.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"

function summarizeBackgroundCounts(tasks = []) {
  const counts = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    interrupted: 0,
    error: 0,
    cancelled: 0
  }
  for (const task of tasks) {
    if (counts[task.status] !== undefined) counts[task.status] += 1
  }
  return counts
}

export async function summarizeSessionRuntimeState({ sessionId = null, cwd = process.cwd(), recoveryEnabled = true } = {}) {
  let resolvedSessionId = sessionId
  if (!resolvedSessionId) {
    const sessions = await listSessions({ cwd, limit: 1, includeChildren: true })
    resolvedSessionId = sessions[0]?.id || null
  }

  const data = resolvedSessionId ? await getSession(resolvedSessionId) : null
  const recoverable = recoveryEnabled
    ? await listRecoverableSessions({ cwd, limit: 20, enabled: true })
    : []
  const backgroundTasks = await BackgroundManager.list()
  const audit = await auditStats()

  return {
    session: data?.session || null,
    messageCount: data?.messages?.length || 0,
    partCount: data?.parts?.length || 0,
    retryMeta: data?.session?.retryMeta || null,
    budgetState: data?.session?.budgetState || null,
    recoverableCount: recoverable.length,
    recoverableSessionIds: recoverable.map((item) => item.id),
    background: summarizeBackgroundCounts(backgroundTasks),
    audit
  }
}
