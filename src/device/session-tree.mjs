import { ProtocolError } from '../protocol/index.mjs'

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** Trusted local ancestry only: never infer ownership from a child ID prefix. */
export class SessionTree {
  constructor({ getSession, maxDepth = 64, maxEntries = 10000 } = {}) {
    this.getSession = getSession
    this.maxDepth = maxDepth
    this.maxEntries = maxEntries
    this.parents = new Map()
    this.names = new Map()
  }
  remember(child, parent, subagent) {
    if (!validId(child) || !validId(parent) || child === parent) return false
    // A child cannot be silently reparented into a separately shared session.
    if (this.parents.has(child) && this.parents.get(child) !== parent) return false
    this.parents.set(child, parent)
    if (subagent) this.names.set(child, String(subagent).slice(0, 120))
    while (this.parents.size > this.maxEntries) {
      const oldest = this.parents.keys().next().value
      this.parents.delete(oldest); this.names.delete(oldest)
    }
    return true
  }
  observe(event) {
    const p = event.payload || {}
    if (p.subSessionId) this.remember(p.subSessionId, event.sessionId, p.subagent)
    if (event.parentSessionId) this.remember(event.sessionId, event.parentSessionId, p.subagent)
  }
  async route(originSessionId) {
    if (!validId(originSessionId)) throw new ProtocolError('invalid_session', 'Invalid approval session id')
    const ancestry = [], seen = new Set()
    let current = originSessionId
    while (current) {
      if (seen.has(current)) throw new ProtocolError('invalid_session_tree', 'Cyclic session ancestry', 409)
      if (ancestry.length >= this.maxDepth) throw new ProtocolError('invalid_session_tree', 'Session ancestry exceeds the depth limit', 409)
      seen.add(current); ancestry.push(current)
      let parent = this.parents.get(current)
      if (!parent && this.getSession) {
        const data = await this.getSession(current)
        const session = data?.session || data
        if (session?.parentSessionId) {
          if (!validId(session.parentSessionId) || session.parentSessionId === current) throw new ProtocolError('invalid_session_tree', 'Invalid session parent', 409)
          parent = session.parentSessionId
          this.remember(current, parent, session.subagent)
        }
      }
      current = parent
    }
    return { sessionId: ancestry.at(-1), originSessionId, parentSessionId: ancestry[1] || null, ancestry, subagent: this.names.get(originSessionId) || null }
  }
  clear() { this.parents.clear(); this.names.clear() }
}
