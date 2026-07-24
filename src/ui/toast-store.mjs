const DEFAULT_DURATION_MS = 2400
const DEFAULT_MAX_TOASTS = 4

function cloneToast(toast) {
  return { ...toast, metadata: { ...toast.metadata } }
}

function normalizeDuration(value, fallback) {
  const duration = Number(value)
  if (!Number.isFinite(duration)) return fallback
  return Math.max(0, duration)
}

/**
 * Transient bottom-notification store. A topic acts as a replacement key, so
 * rapid model/mode/policy changes update one toast instead of stacking logs.
 */
export function createToastStore({
  durationMs = DEFAULT_DURATION_MS,
  maxToasts = DEFAULT_MAX_TOASTS,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer)
} = {}) {
  const fallbackDuration = normalizeDuration(durationMs, DEFAULT_DURATION_MS)
  const limit = Math.max(1, Number(maxToasts) || DEFAULT_MAX_TOASTS)
  const listeners = new Set()
  const toasts = []
  let sequence = 0
  let expiryTimer = null

  function notify(type, toast = null) {
    const event = {
      type,
      toast: toast ? cloneToast(toast) : null,
      toasts: toasts.map(cloneToast)
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // A UI observer must not prevent toast expiry.
      }
    }
  }

  function cancelExpiryTimer() {
    if (expiryTimer === null) return
    clearTimer(expiryTimer)
    expiryTimer = null
  }

  function scheduleExpiry() {
    cancelExpiryTimer()
    const expiring = toasts
      .filter((toast) => toast.expiresAt !== null)
      .sort((left, right) => left.expiresAt - right.expiresAt)[0]
    if (!expiring) return
    const delay = Math.max(0, expiring.expiresAt - now())
    expiryTimer = setTimer(() => {
      expiryTimer = null
      prune()
    }, delay)
    expiryTimer?.unref?.()
  }

  function prune(at = now()) {
    const before = toasts.length
    for (let index = toasts.length - 1; index >= 0; index--) {
      const expiry = toasts[index].expiresAt
      if (expiry !== null && expiry <= at) toasts.splice(index, 1)
    }
    if (toasts.length !== before) notify("expire")
    scheduleExpiry()
    return before - toasts.length
  }

  function show(input, options = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input)
      ? { ...input, ...options }
      : { ...options, message: input }
    const message = String(source.message ?? source.text ?? "")
    const topic = source.topic === null || source.topic === undefined
      ? ""
      : String(source.topic)
    const ttl = normalizeDuration(source.durationMs ?? source.ttlMs, fallbackDuration)
    const timestamp = now()
    const expiresAt = ttl === 0 ? null : timestamp + ttl
    const existingIndex = topic
      ? toasts.findIndex((toast) => toast.topic === topic)
      : -1
    const existing = existingIndex >= 0 ? toasts[existingIndex] : null

    if (existing) {
      existing.message = message
      existing.tone = String(source.tone || existing.tone || "info")
      existing.updatedAt = timestamp
      existing.expiresAt = expiresAt
      existing.metadata = {
        ...existing.metadata,
        ...(source.metadata && typeof source.metadata === "object" ? source.metadata : {})
      }
      // The replaced topic is the newest notification and must be the one a
      // single-line toast surface displays.
      toasts.splice(existingIndex, 1)
      toasts.push(existing)
      notify("replace", existing)
      scheduleExpiry()
      return existing.id
    }

    sequence += 1
    const toast = {
      id: String(source.id || `toast_${sequence}`),
      topic,
      message,
      tone: String(source.tone || "info"),
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt,
      metadata: source.metadata && typeof source.metadata === "object"
        ? { ...source.metadata }
        : {}
    }
    toasts.push(toast)
    if (toasts.length > limit) toasts.splice(0, toasts.length - limit)
    notify("show", toast)
    scheduleExpiry()
    return toast.id
  }

  function dismiss(id) {
    const index = toasts.findIndex((toast) => toast.id === id)
    if (index < 0) return false
    const [removed] = toasts.splice(index, 1)
    notify("dismiss", removed)
    scheduleExpiry()
    return true
  }

  function dismissTopic(topic) {
    const key = String(topic || "")
    if (!key) return 0
    let removed = 0
    for (let index = toasts.length - 1; index >= 0; index--) {
      if (toasts[index].topic !== key) continue
      toasts.splice(index, 1)
      removed += 1
    }
    if (removed > 0) notify("dismiss-topic")
    scheduleExpiry()
    return removed
  }

  function clear() {
    cancelExpiryTimer()
    if (toasts.length === 0) return
    toasts.length = 0
    notify("clear")
  }

  function dispose() {
    cancelExpiryTimer()
    toasts.length = 0
    listeners.clear()
  }

  return {
    push: show,
    show,
    dismiss,
    dismissTopic,
    prune,
    clear,
    dispose,
    getToasts({ pruneExpired = true } = {}) {
      if (pruneExpired) prune()
      return toasts.map(cloneToast)
    },
    getNextExpiryAt() {
      const expiries = toasts
        .map((toast) => toast.expiresAt)
        .filter((expiry) => expiry !== null)
      return expiries.length ? Math.min(...expiries) : null
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
