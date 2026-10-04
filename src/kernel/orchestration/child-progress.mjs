import { EVENT_TYPES } from '../core/constants.mjs'
import { EventBus } from '../core/events.mjs'
import { modelRuntimeProfile } from '../provider/runtime-parameters.mjs'
import { resolveProviderRouteSettings } from '../provider/route-settings.mjs'
import { childSnapshot, updateChildOperation } from './child-state.mjs'

/** Persist bounded presentation facts, never streaming text or tool arguments.
 * Cross-process clients can refresh these facts without issuing model calls. */
export async function observeChildProgress({ sessionId, operationId, configState, providerType, model, baseUrl, apiKeyEnv }) {
  if (!operationId) return () => {}
  const settings = resolveProviderRouteSettings(configState, providerType, { model, baseUrl, apiKeyEnv })
  const profile = modelRuntimeProfile(configState, settings)
  await updateChildOperation(sessionId, operationId, { childRuntime: { model: settings.model, provider: settings.configKey,
    thinking: profile.thinking.options.find(option => option.value === profile.thinking.selected)?.label || '自动',
    output_reserved: profile.output.reserved, context_limit: profile.context.limit } })
  const phases = { 'turn.step.start': 'thinking', 'stream.thinking.start': 'thinking', 'stream.text.start': 'writing',
    'tool.start': 'tool', 'permission.asked': 'approval', 'turn.waiting.children': 'waiting_children', 'turn.finish': 'finishing', 'turn.error': 'error' }
  let step = null
  return EventBus.subscribe(async event => {
    if (event.sessionId !== sessionId || !Object.hasOwn(phases, event.type)) return
    if (Number.isSafeInteger(event.payload?.step)) step = event.payload.step
    const child = await updateChildOperation(sessionId, operationId, { childProgress: { phase: phases[event.type],
      step, tool: event.type === 'tool.start' ? String(event.payload?.tool || event.payload?.name || '').slice(0, 80) : '' } })
    if (child) await EventBus.emit({ type: EVENT_TYPES.SUBAGENT_PROGRESS, sessionId: child.childContract.parentSessionId,
      payload: { subSessionId: sessionId, child: childSnapshot(child) } })
  })
}
