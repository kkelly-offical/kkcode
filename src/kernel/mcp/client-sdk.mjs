import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client'
import { MCP_CLIENT_INFO } from './constants.mjs'
import { normalizeToolResult } from './tool-result.mjs'
import { buildRequestHeaders } from '../../http/identity.mjs'
import { createMcpOAuthProvider } from './oauth.mjs'

export function createSdkMcpClient(serverName, config) {
  let client, connecting
  const timeout = Number(config.timeout_ms || 15000)
  async function connect() {
    if (!connecting) connecting = (async () => {
      const url = new URL(config.url || config.base_url)
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid MCP endpoint')
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Object.keys(config.headers || {}).length) throw new Error('MCP credentials require HTTPS outside loopback')
      client = new Client(MCP_CLIENT_INFO, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
      const Transport = String(config.transport || config.type).toLowerCase() === 'legacy-sse' ? SSEClientTransport : StreamableHTTPClientTransport
      let authProvider
      // A public HTTP MCP may be intentionally unauthenticated. Only a prior
      // explicit OAuth login enables bearer/refresh behavior for this endpoint.
      if (url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        const auth = createMcpOAuthProvider(serverName, config)
        if (await auth.initialize()) authProvider = auth.provider
      }
      await client.connect(new Transport(url, { ...(authProvider ? { authProvider } : {}), requestInit: { headers: buildRequestHeaders({ target: 'mcp', accept: 'application/json, text/event-stream', customHeaders: config.headers || {} }) } }), { timeout })
      return client
    })().catch(async error => { await client?.close().catch(() => {}); connecting = null; throw error })
    return connecting
  }
  async function list(method, key) {
    const peer = await connect(), items = [], seen = new Set()
    let cursor
    do {
      const result = await peer[method](cursor ? { cursor } : {}, { timeout })
      items.push(...(result[key] || []))
      cursor = result.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Repeated MCP catalog cursor')
      if (cursor) seen.add(cursor)
      if (items.length > 10000) throw new Error('MCP catalog limit exceeded')
    } while (cursor)
    return items
  }
  return {
    async health() { try { await connect(); return { ok: true, protocol: client.getServerVersion?.() } } catch (error) { return { ok: false, error: error.message, reason: 'connection_failed' } } },
    listTools: () => list('listTools', 'tools'),
    listPrompts: () => list('listPrompts', 'prompts'),
    listResources: () => list('listResources', 'resources'),
    listTemplates: () => list('listResourceTemplates', 'resourceTemplates'),
    async getPrompt(name, args = {}) { return (await connect()).getPrompt({ name, arguments: args }, { timeout }) },
    async readResource(uri) { return (await connect()).readResource({ uri }, { timeout }) },
    async callTool(name, args = {}, signal) {
      const result = await (await connect()).callTool({ name, arguments: args }, { timeout, signal })
      return normalizeToolResult(result, serverName, name)
    },
    async shutdown() { await client?.close(); client = null; connecting = null }
  }
}
