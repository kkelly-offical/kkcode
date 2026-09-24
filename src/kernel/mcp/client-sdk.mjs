import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client'
import { MCP_CLIENT_INFO } from './constants.mjs'
import { normalizeToolResult } from './tool-result.mjs'
import { buildRequestHeaders } from '../../http/identity.mjs'
import { createMcpOAuthProvider } from './oauth.mjs'
import { createMcpInteraction } from './interaction.mjs'
import { deferredSdkSchemaValidator, boundedSchemaJson, snapshotToolArguments } from '../tool/schema-validation.mjs'
import { validateMcpInput, validateMcpOutput } from './schema-validation.mjs'

export function createSdkMcpClient(serverName, config, host = {}) {
  let client, connecting
  const timeout = Number(config.timeout_ms || 15000)
  const interaction = createMcpInteraction(serverName, host)
  async function connect() {
    if (!connecting) connecting = (async () => {
      const url = new URL(config.url || config.base_url)
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid MCP endpoint')
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Object.keys(config.headers || {}).length) throw new Error('MCP credentials require HTTPS outside loopback')
      client = new Client(MCP_CLIENT_INFO, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' }, inputRequired: { maxRounds: 10 }, jsonSchemaValidator: deferredSdkSchemaValidator })
      client.setRequestHandler('elicitation/create', (request, context) => interaction.elicit(request.params, context.mcpReq.signal))
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
  async function list(method, key, options = {}) {
    const peer = await connect(), items = [], seen = new Set()
    let cursor
    do {
      const result = await peer[method](cursor ? { cursor } : {}, { timeout, ...options })
      items.push(...(result[key] || []))
      cursor = result.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Repeated MCP catalog cursor')
      if (cursor) seen.add(cursor)
      if (items.length > 10000 || seen.size > 10000) throw new Error('MCP catalog limit exceeded')
    } while (cursor)
    return items
  }
  async function invoke(method, params, options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
    return interaction.run(method, signal, async () => {
      let peer
      try { peer = await connect() } catch (error) { throw Object.assign(error, { operationNotStarted: true }) }
      return peer[method](params, { timeout, maxTotalTimeout: timeout, ...options, signal })
    })
  }
  return {
    async health() { try { await connect(); return { ok: true, protocol: client.getServerVersion?.() } } catch (error) { return { ok: false, error: error.message, reason: 'connection_failed' } } },
    listTools: options => list('listTools', 'tools', options),
    listPrompts: options => list('listPrompts', 'prompts', options),
    listResources: options => list('listResources', 'resources', options),
    listTemplates: options => list('listResourceTemplates', 'resourceTemplates', options),
    async getPrompt(name, args = {}, options = {}) { return invoke('getPrompt', { name, arguments: args }, options) },
    async readResource(uri, options = {}) { return invoke('readResource', { uri }, options) },
    async callTool(name, args = {}, signal, options = {}) {
      try { args = snapshotToolArguments(args) } catch (error) { throw Object.assign(error, { operationNotStarted: true }) }
      // Official SDK v2 synchronously compiles and executes output validators.
      // Its injected hook deliberately does neither: this private adapter takes
      // over *both* checks before any result becomes observable to callers.
      let definition
      try {
        const peer = await connect()
        const listed = await peer.listTools(undefined, { timeout, signal })
        const found = listed.tools.find(tool => tool.name === name)
        if (!found) throw new Error('MCP 工具不在当前服务目录中，未发送调用。')
        definition = JSON.parse(boundedSchemaJson(found))
        await validateMcpInput(definition, args, signal)
      } catch (error) { throw Object.assign(error, { operationNotStarted: true }) }
      const result = await invoke('callTool', { name, arguments: args }, { ...options, signal, toolDefinition: definition })
      await validateMcpOutput(definition, result, signal)
      return normalizeToolResult(result, serverName, name)
    },
    async shutdown() { await client?.close(); client = null; connecting = null }
  }
}
