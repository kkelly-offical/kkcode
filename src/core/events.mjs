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
