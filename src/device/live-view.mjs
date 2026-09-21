const presentationTypes = new Set(['turn.start', 'turn.auto_continue', 'stream.text.start', 'stream.text.delta', 'stream.thinking.start', 'stream.thinking.delta', 'stream.end', 'tool.start', 'turn.finish', 'turn.result', 'turn.failed'])
const terminalTypes = new Set(['turn.finish', 'turn.result', 'turn.failed'])
const stepKey = (turnId, step) => `${turnId}:${step}`
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const tail = (value, budget) => {
  if (Buffer.byteLength(value) <= budget) return value
  return Array.from(value).slice(-Math.max(1, Math.floor(budget / 4))).join('')
}

/** Bounded transient presentation state, independent of canonical history.
 * Journal append + presentation update and snapshot/cursor reads share one queue.
 * Canonical writers do not use that queue: capture the cursor FIRST, so a later
 * canonical write is either in the snapshot or in a subsequent replay event.
 */
export class DeviceLiveView {
  constructor({ maxSessionBytes = 512 * 1024, maxTotalBytes = 8 * 1024 * 1024, maxSessions = 64, maxSegments = 64 } = {}) {
    this.limits = { maxSessionBytes, maxTotalBytes, maxSessions, maxSegments }
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid live-view limit')
    if (maxSessionBytes < 1024 || maxTotalBytes < maxSessionBytes) throw new TypeError('Live-view byte budgets are too small')
    this.sessions = new Map(); this.evicted = new Map(); this.chain = Promise.resolve(); this.closed = false
  }
  exclusive(operation) {
    if (this.closed) return Promise.reject(new Error('Live view is closed'))
    const work = this.chain.then(operation); this.chain = work.catch(() => {}); return work
  }
  record(event, append) {
    return this.exclusive(async () => {
      const row = await append(event)
      this.observe({ ...event, seq: row.seq, timestamp: row.timestamp, id: row.id })
      return row
    })
  }
  observe(event) {
    if (!presentationTypes.has(event.type)) return
    const id = event.sessionId, payload = event.payload || {}
    let state = this.sessions.get(id), turnId = event.type === 'turn.result' ? payload.turnId || event.turnId : event.turnId
    if (terminalTypes.has(event.type) && state) turnId = state.turnId
    if (!turnId) return
    if (!state || state.turnId !== turnId || event.type === 'turn.start') {
      state = { turnId, prompt: null, segments: [], generations: new Map(), terminal: null, truncated: false, bytes: 0 }
      this.sessions.delete(id); this.sessions.set(id, state); this.evicted.delete(id)
    }
    const item = { id: `live-${event.id}`, sessionId: id, turnId, seq: event.seq, timestamp: event.timestamp, type: event.type, payload: { step: payload.step } }
    if (event.type === 'turn.start') {
      const prompt = String(payload.prompt || '')
      item.payload.prompt = tail(prompt, Math.floor(this.limits.maxSessionBytes / 4))
      state.truncated ||= item.payload.prompt !== prompt
      state.prompt = item
    } else if (event.type === 'turn.auto_continue') {
      const key = stepKey(turnId, payload.step)
      state.generations.set(key, (state.generations.get(key) || 0) + 1)
    } else if (terminalTypes.has(event.type)) {
      item.payload = { ...(payload.step != null ? { step: payload.step } : {}), ...(payload.reply ? { reply: tail(String(payload.reply), Math.floor(this.limits.maxSessionBytes / 4)) } : {}), ...(payload.error ? { error: tail(String(payload.error), 4096) } : {}) }
      state.terminal = item
      if (payload.reply && item.payload.reply !== String(payload.reply)) state.truncated = true
    } else if (event.type === 'stream.end' || event.type === 'tool.start') {
      item.type = 'stream.end'
      state.segments.push({ event: item, generation: state.generations.get(stepKey(turnId, payload.step)) || 0 })
    } else {
      const kind = event.type.includes('thinking') ? 'thinking' : 'text', type = `stream.${kind}.delta`
      const generation = state.generations.get(stepKey(turnId, payload.step)) || 0
      const last = state.segments.at(-1)
      let segment = last?.event.type === type && last.event.payload.step === payload.step && last.generation === generation ? last : null
      if (!segment) { item.type = type; item.payload.text = ''; segment = { event: item, generation }; state.segments.push(segment) }
      if (event.type.endsWith('.delta')) segment.event.payload.text += String(payload.text || '')
      segment.event.seq = event.seq
    }
    this.trim(id, state)
  }
  trim(id, state) {
    const measure = () => bytes({ prompt: state.prompt, segments: state.segments, terminal: state.terminal })
    while (state.segments.length > this.limits.maxSegments) { state.segments.shift(); state.truncated = true }
    while (state.generations.size > this.limits.maxSegments) { state.generations.delete(state.generations.keys().next().value); state.truncated = true }
    while (state.segments.length > 1 && measure() > this.limits.maxSessionBytes) { state.segments.shift(); state.truncated = true }
    if (measure() > this.limits.maxSessionBytes) {
      for (const segment of state.segments) if (segment.event.payload.text) segment.event.payload.text = tail(segment.event.payload.text, Math.floor(this.limits.maxSessionBytes / 4))
      state.truncated = true
    }
    // Metadata/prompt/error can dominate a deliberately tiny configured budget.
    if (measure() > this.limits.maxSessionBytes) { state.prompt = null; state.terminal = null; state.truncated = true }
    while (measure() > this.limits.maxSessionBytes && state.segments.some(segment => segment.event.payload.text)) {
      for (const segment of state.segments) if (segment.event.payload.text) segment.event.payload.text = Array.from(segment.event.payload.text).slice(Math.ceil(Array.from(segment.event.payload.text).length / 2)).join('')
    }
    if (measure() > this.limits.maxSessionBytes) { state.segments = []; state.truncated = true }
    state.bytes = measure()
    this.sessions.delete(id); this.sessions.set(id, state)
    while (this.sessions.size > this.limits.maxSessions || this.stats().bytes > this.limits.maxTotalBytes) {
      const oldest = this.sessions.keys().next().value
      this.sessions.delete(oldest); this.evicted.set(oldest, true)
    }
    while (this.evicted.size > this.limits.maxSessions * 2) this.evicted.delete(this.evicted.keys().next().value)
  }
  project(sessionId, canonical) {
    const state = this.sessions.get(sessionId)
    if (!state) return { liveEvents: [], liveTruncated: this.evicted.has(sessionId) }
    const messages = canonical?.messages || [], completed = new Set(), partials = new Map()
    for (const message of messages) if (message.role === 'assistant') {
      const key = stepKey(message.turnId, message.step)
      if (message.truncated) partials.set(key, (partials.get(key) || 0) + 1)
      else completed.add(key)
    }
    const events = []
    if (state.prompt && !messages.some(message => message.role === 'user' && message.turnId === state.turnId)) events.push(state.prompt)
    for (const segment of state.segments) {
      const key = stepKey(state.turnId, segment.event.payload.step)
      if (completed.has(key) || segment.generation < (partials.get(key) || 0)) continue
      events.push(segment.event)
    }
    if (state.terminal && (state.terminal.type === 'turn.failed' || !messages.some(message => message.role === 'assistant' && message.turnId === state.turnId && !message.truncated))) events.push(state.terminal)
    return { liveEvents: structuredClone(events), liveTruncated: state.truncated }
  }
  snapshot(sessionId, { readCursor, readCanonical, project = value => value, includeLive = true } = {}) {
    return this.exclusive(async () => {
      const cursor = await readCursor()
      const canonical = await readCanonical()
      if (!canonical) return null
      return { ...project(canonical), eventCursor: typeof cursor === 'number' ? cursor : cursor.cursor, ...(includeLive ? this.project(sessionId, canonical) : {}) }
    })
  }
  stats() { return { ...this.limits, sessions: this.sessions.size, bytes: [...this.sessions.values()].reduce((sum, state) => sum + state.bytes, 0) } }
  async close() { if (this.closed) return; this.closed = true; await this.chain; this.sessions.clear(); this.evicted.clear() }
}
