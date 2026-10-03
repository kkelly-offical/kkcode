import {getSession, deliverQueuedSteering} from './store.mjs'

export async function pendingSteering(sessionId, {executionId, excludeExecutionId} = {}) {
  const saved = await getSession(sessionId)
  const delivered = new Set((saved?.parts || []).filter(part => part.type === 'steering.delivered').map(part => part.guidanceId))
  return (saved?.parts || []).filter(part => part.type === 'steering.queued' && part.source === 'user' && !delivered.has(part.id)
    && (executionId === undefined || part.executionId === executionId) && part.executionId !== excludeExecutionId)
}

export function sessionSteeringSource(sessionId, executionId, original = null) {
  const source = async () => [...(original ? await original() : []), ...(await pendingSteering(sessionId, {executionId})).map(part => ({
    text: part.text, deliver: turnId => deliverQueuedSteering(sessionId, part.id, turnId)
  }))]
  source.hasPending = async () => Boolean(await original?.hasPending?.()) || (await pendingSteering(sessionId, {executionId})).length > 0
  return source
}

/** Carry undelivered input into history BEFORE the new user's prompt so newer
 * instructions keep precedence. This starts no task and replays no operation. */
export async function retainEarlierSteering(sessionId, executionId) {
  for (const part of await pendingSteering(sessionId, {excludeExecutionId: executionId})) await deliverQueuedSteering(sessionId, part.id)
}
