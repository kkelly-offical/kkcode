import { makeEventEnvelope } from "./types.mjs"

const listeners = new Set()
const sinks = new Set()

export const EventBus = {
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  registerSink(fn) {
    sinks.add(fn)
    return () => sinks.delete(fn)
  },
  /**
   * 当前监听器数量。诊断与测试用 —— 长跑的编排器（Ultra）会在启动时订阅
   * stop 事件，如果某条返回路径漏了退订就会每跑一次泄漏一个监听器，
   * 而这种泄漏没有别的办法能观察到。
   */
  listenerCount() {
    return listeners.size
  },
  async emit(input) {
    const event = makeEventEnvelope(input)
    for (const sink of sinks) {
      try { await sink(event) } catch (err) {
        console.error("[events] sink error:", err?.message || err)
      }
    }
    for (const fn of listeners) {
      try { await fn(event) } catch (err) {
        console.error("[events] listener error:", err?.message || err)
      }
    }
    return event
  }
}
