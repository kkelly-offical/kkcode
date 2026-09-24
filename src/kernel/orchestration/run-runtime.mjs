import { currentRuntime, runWithRuntime } from '../core/runtime-context.mjs'

// Only live host-created bindings cross into the tool executor. JSON and model
// arguments cannot mint a durable-run capability.
const bindings = new WeakSet()

export function createDurableRunBinding(handlers) {
  const binding = Object.freeze({ ...handlers })
  bindings.add(binding)
  return binding
}

export function currentDurableRun() {
  const binding = currentRuntime()?.durableRun
  return binding && bindings.has(binding) ? binding : null
}

export function withDurableRun(binding, operation) {
  if (!bindings.has(binding)) throw new Error('Durable run context must be created by the trusted host')
  return runWithRuntime({ ...currentRuntime(), durableRun: binding }, operation)
}
