import { processTurnLoop } from './loop.mjs'
import { LongAgentManager } from '../orchestration/longagent-manager.mjs'
import { currentRuntime, runWithRuntime, runtimeCwd } from '../core/runtime-context.mjs'
import { EventBus } from '../core/events.mjs'
import { EVENT_TYPES } from '../core/constants.mjs'
import { getTodoSnapshot, markSessionStatus, touchSession } from './store.mjs'
import { getAgentPrompt } from '../agent/agent.mjs'

/** Ordinary Ultra: model-authored stages, durable ToDos and execution state.
 * Explicit host acceptance continues through the existing staged runner. */
export async function runAdaptiveLongAgent(args) {
  const { sessionId, configState, model, providerType, signal } = args
  const cwd = runtimeCwd(), controller = new AbortController()
  await touchSession({sessionId,cwd,model,providerType,mode:'longagent',status:'running-longagent'})
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const duration = Number(configState.config.agent?.longagent?.ultra?.deadline_ms ?? 7200000)
  const deadlineAt = duration > 0 ? Date.now() + duration : null
  let iterations = 0, queue = Promise.resolve(), syncing = false, terminal = false
  const sync = patch => {
    queue = queue.then(async () => {
      const snapshot = await getTodoSnapshot(sessionId)
      const items = snapshot?.items || []
      return LongAgentManager.update(sessionId, { orchestration: 'adaptive',
        iterations, heartbeatAt: Date.now(), stageCount: items.length,
        stageProgress: { done: items.filter(x => x.status === 'completed').length, total: items.length },
        stagePlan: { objective: args.prompt, stages: items.map(item => ({stageId:item.id, name:item.content, status:item.status, tasks:[]})) },
        todoRevision: snapshot?.revision ?? null, ...patch }, cwd)
    })
    return queue
  }
  await LongAgentManager.clearStop(sessionId, cwd)
  await sync({ status:'running', phase:'adaptive', deadlineAt, lastMessage:'按任务需要规划和执行' })
  const unsubscribe = EventBus.subscribe(event => {
    if (event.sessionId !== sessionId || terminal) return
    if (event.type === EVENT_TYPES.LONGAGENT_STOP_REQUESTED) controller.abort(Object.assign(new Error('Ultra stopped by user'), {code:'ULTRA_STOP'}))
    if (event.type === EVENT_TYPES.TURN_STEP_START) iterations++
    if (event.type === 'todo.updated' || event.type === EVENT_TYPES.TURN_STEP_FINISH) void sync({ status:'running' }).catch(error => controller.abort(error))
  })
  const timer = setInterval(async () => {
    if (syncing || terminal) return
    syncing = true
    try {
      const state = await LongAgentManager.get(sessionId, cwd)
      if (state?.stopRequested) controller.abort(Object.assign(new Error('Ultra stopped by user'), {code:'ULTRA_STOP'}))
      else if (deadlineAt && Date.now() >= deadlineAt) controller.abort(Object.assign(new Error('Ultra deadline exceeded'), { code:'ULTRA_DEADLINE' }))
    } catch (error) { controller.abort(error) }
    finally { syncing = false }
  }, 1000)
  timer.unref?.()
  try {
    const instructions = [await getAgentPrompt('assistant'),
      'For this persistent task, choose the stages, delegation and checks that help achieve the user objective. Keep multi-step work in durable ToDos and update progress as work changes.',
      'Use existing task sessions and evidence when continuing. A ToDo or child report is not acceptance. Inspect unknown effects before resuming; do not replay cancelled operations.',
      'Do not generate a blueprint, scaffolding, a separate review, or tests just to satisfy a workflow. Use appropriate checks when the task calls for them; preserve explicitly requested checks.',
      'When the requested work is done, respond normally. No special completion markers are required.'
    ].join('\n\n')
    const max = Number(args.maxIterations || 0)
    const effectiveConfig = max > 0 ? { ...configState, config:{...configState.config,agent:{...configState.config.agent,max_steps:Math.min(configState.config.agent.max_steps || 128,max)}} } : configState
    const run = args.deps?.processTurnLoop || processTurnLoop
    const result = await runWithRuntime({ ...currentRuntime(), cwd, sessionSelection:{sessionId,mode:'longagent',model,providerType} }, () => run({ ...args,
      configState:effectiveConfig, mode:'longagent', agent:{...args.agent, name:'assistant',prompt:instructions}, signal:combined }))
    terminal = true
    await queue
    await sync({ status:result.status === 'completed' ? 'completed' : 'blocked',
      completionPolicy: result.verification?.required ? 'required' : 'observational',
      stopReason:result.stopReason || null, verification:result.verification || null, lastMessage:result.reply?.slice(0,300) || '' })
    return {...result, orchestration:'adaptive', iterations}
  } catch (error) {
    terminal = true
    await queue.catch(() => {})
    const status = controller.signal.reason?.code === 'ULTRA_DEADLINE' ? 'deadline_exhausted' : signal?.aborted || controller.signal.reason?.code === 'ULTRA_STOP' ? 'user_stopped' : 'fatal'
    await LongAgentManager.update(sessionId,{status,iterations,stopReason:status,lastMessage:String(error.message || error).slice(0,300)},cwd).catch(()=>{})
    await markSessionStatus(sessionId,status === 'fatal' ? 'failed' : 'active').catch(()=>{})
    throw error
  } finally { terminal=true; clearInterval(timer); unsubscribe(); await queue.catch(()=>{}) }
}
