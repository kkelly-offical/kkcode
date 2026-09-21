import { AsyncLocalStorage } from 'node:async_hooks'

// Bind a dependency container to the whole asynchronous execution chain. Legacy
// imports remain callable outside a kernel; inside a kernel they resolve only
// that kernel's dependencies. No process-global trust/handler swapping.
const execution = new AsyncLocalStorage()
export const currentRuntime = () => execution.getStore()
export const runWithRuntime = (runtime, fn) => execution.run(runtime, fn)
export const runtimeCwd = () => currentRuntime()?.cwd ?? process.cwd()
export function runtimeDependency(key, fallback) { return currentRuntime()?.[key] ?? fallback }
export function contextualObject(key, fallback) {
  return new Proxy(fallback, {
    get(target, property) {
      const actual = runtimeDependency(key, target)
      const value = Reflect.get(actual, property, actual)
      return typeof value === 'function' ? value.bind(actual) : value
    },
    set(target, property, value) { return Reflect.set(runtimeDependency(key, target), property, value) }
  })
}
