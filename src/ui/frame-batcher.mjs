const DEFAULT_FRAME_MS = 16

/**
 * Coalesce repeated render invalidations into at most one callback per frame.
 *
 * `flushNow()` is intended for stream-finalization boundaries: it cancels a
 * pending timer and synchronously publishes the latest accumulated state
 * before the caller clears that state or marks it complete.
 */
export function createFrameBatcher({
  flush,
  frameMs = DEFAULT_FRAME_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof flush !== "function") {
    throw new TypeError("createFrameBatcher requires a flush callback")
  }

  const delay = Math.max(0, Number(frameMs) || 0)
  let timer = null
  let dirty = false
  let disposed = false

  function run() {
    timer = null
    if (disposed || !dirty) return false
    dirty = false
    flush()
    return true
  }

  function schedule() {
    if (disposed) return false
    dirty = true
    if (timer !== null) return false
    timer = setTimer(run, delay)
    timer?.unref?.()
    return true
  }

  function flushNow() {
    if (disposed || !dirty) return false
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    return run()
  }

  function dispose() {
    disposed = true
    dirty = false
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    schedule,
    flushNow,
    dispose,
    get pending() {
      return dirty
    }
  }
}
