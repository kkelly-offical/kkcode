import { updateSession, listSessions, getSession } from "./store.mjs"

export function isRecoveryEnabled(config = {}) {
  return config?.session?.recovery !== false
}

export async function markTurnInProgress(sessionId, turnId, step = 0, enabled = true) {
  if (!enabled) return
  await updateSession(sessionId, {
    retryMeta: {
      inProgress: true,
      turnId,
      step,
      updatedAt: Date.now()
    }
  })
}

export async function markTurnFinished(sessionId, enabled = true) {
  if (!enabled) return
  await updateSession(sessionId, {
    retryMeta: {
      inProgress: false,
      updatedAt: Date.now()
    }
  })
}

export async function listRecoverableSessions({ cwd = null, limit = 50, enabled = true } = {}) {
  if (!enabled) return []
  const sessions = await listSessions({ cwd, limit })
  return sessions.filter(
    (session) => session.retryMeta?.inProgress || session.status === "error"
  )
}

export async function getResumeContext(sessionId, { enabled = true } = {}) {
  if (!enabled) return null
  const data = await getSession(sessionId)
  if (!data) return null
  const { session, messages } = data
  const userMessages = messages.filter((m) => m.role === "user" && !m.synthetic)
  const lastUserMessage = userMessages.length ? userMessages[userMessages.length - 1] : null
  return {
    session,
    lastPrompt: lastUserMessage?.content || null,
    messageCount: messages.length,
    retryMeta: session.retryMeta || null,
    canResume: Boolean(lastUserMessage),
    canRetry: Boolean(session.retryMeta?.failedAt)
  }
}

export function summarizeResumeContext(resumeCtx) {
  if (!resumeCtx) return null
  const retryMeta = resumeCtx.retryMeta || {}
  const status = retryMeta.inProgress
    ? "in-progress"
    : resumeCtx.canRetry
      ? "retryable-error"
      : resumeCtx.canResume
        ? "resumable"
        : "idle"
  return {
    status,
    canResume: resumeCtx.canResume,
    canRetry: resumeCtx.canRetry,
    messageCount: resumeCtx.messageCount,
    lastPromptPreview: resumeCtx.lastPrompt ? `${String(resumeCtx.lastPrompt).slice(0, 100)}${String(resumeCtx.lastPrompt).length > 100 ? "..." : ""}` : "",
    retryStep: Number(retryMeta.step || 0),
    turnId: retryMeta.turnId || null
  }
}
