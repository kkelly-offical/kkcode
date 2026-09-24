import { McpServer, ResourceTemplate, Server, createMcpHandler, WebStandardStreamableHTTPServerTransport, inputRequired } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

async function slowRequest(ctx) {
  const signal = ctx.mcpReq.signal
  if (ctx.mcpReq._meta?.progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: ctx.mcpReq._meta.progressToken, progress: 1, total: 3 } })
  await new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, 3000)
    const abort = () => { clearTimeout(timer); reject(new Error('fixture cancelled')) }
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
}

export function fixtureServer() {
  const server = new McpServer({ name: 'KK Code official SDK acceptance', version: '1.0.1' })
  server.registerTool('echo', { description: 'Typed Unicode echo', inputSchema: z.object({ text: z.string().min(1), repeat: z.number().int().min(1).max(3).optional(), label: z.string().nullable().optional() }).strict(), outputSchema: z.object({ text: z.string(), repeat: z.number() }) }, async ({ text, repeat = 1 }) => ({ content: [{ type: 'text', text: text.repeat(repeat) }], structuredContent: { text, repeat } }))
  server.registerTool('failure', { description: 'Fixture tool error', inputSchema: z.object({}) }, async () => ({ isError: true, content: [{ type: 'text', text: 'fixture controlled error' }] }))
  server.registerTool('collect', { description: 'Two real user input rounds', inputSchema: z.object({ label: z.string().default('fixture'), sensitive: z.boolean().optional() }) }, async ({ label, sensitive }, ctx) => {
    if (ctx.mcpReq._meta?.progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: ctx.mcpReq._meta.progressToken, progress: 1, total: 2 } })
    const state = ctx.mcpReq.requestState(), answer = ctx.mcpReq.inputResponses?.form
    if (answer && answer.action !== 'accept') return { content: [{ type: 'text', text: answer.action }] }
    if (state === 'round-two') return { content: [{ type: 'text', text: `${label}:${answer?.content?.text}` }], structuredContent: answer?.content }
    return inputRequired({ inputRequests: { form: inputRequired.elicit({ message: `Provide ${label}`, requestedSchema: { type: 'object', properties: { [sensitive ? 'api_key' : 'text']: { type: 'string', minLength: 1 } }, required: [sensitive ? 'api_key' : 'text'] } }) }, requestState: state ? 'round-two' : 'round-one' })
  })
  server.registerTool('wait', { inputSchema: z.object({}) }, async (_args, ctx) => {
    await slowRequest(ctx)
    return { content: [{ type: 'text', text: 'waited' }] }
  })
  server.registerTool('cancel_form', { inputSchema: z.object({}) }, async (_args, ctx) => {
    await ctx.mcpReq.elicitInput({ message: 'cancel fixture', requestedSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, { signal: AbortSignal.timeout(100) }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    return { content: [{ type: 'text', text: 'form cancelled by server' }] }
  })
  server.registerPrompt('review', { description: 'Review a named file', argsSchema: z.object({ file: z.string() }) }, ({ file }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review ${file}` } }] }))
  server.registerPrompt('slow', { argsSchema: z.object({}) }, async (_args, ctx) => { await slowRequest(ctx); return { messages: [] } })
  server.registerResource('slow', 'fixture://slow', { mimeType: 'text/plain' }, async (uri, ctx) => { await slowRequest(ctx); return { contents: [{ uri: uri.href, text: 'done' }] } })
  server.registerResource('guide', 'fixture://guide', { description: 'Fixture guide', mimeType: 'text/plain' }, uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Guide: 参数可选，不执行用户代码。' }] }))
  server.registerResource('file', new ResourceTemplate('fixture://files/{name}', { list: undefined }), { description: 'Fixture file template', mimeType: 'text/plain' }, (uri, { name }) => ({ contents: [{ uri: uri.href, text: `File ${name}` }] }))
  return server
}

export function pagedFixtureServer({ repeatCursor = false } = {}) {
  const server = new Server({ name: 'KK Code paged official SDK fixture', version: '1.0.1' }, { capabilities: { tools: {}, resources: {}, prompts: {} } })
  const lists = { 'tools/list': ['tools', n => ({ name: `echo_${n}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } })], 'prompts/list': ['prompts', n => ({ name: `prompt_${n}`, arguments: [{ name: 'file', required: true }] })], 'resources/list': ['resources', n => ({ name: `resource_${n}`, uri: `fixture://resource/${n}` })], 'resources/templates/list': ['resourceTemplates', n => ({ name: `template_${n}`, uriTemplate: `fixture://template-${n}/{id}` })] }
  for (const [method, [key, item]] of Object.entries(lists)) server.setRequestHandler(method, request => ({ [key]: [item(request.params?.cursor ? 2 : 1)], ...(request.params?.cursor && !repeatCursor ? {} : { nextCursor: 'next' }) }))
  server.setRequestHandler('tools/call', request => ({ content: [{ type: 'text', text: request.params.arguments.text }] }))
  return server
}

/** Only HTTP adaptation is local code; all MCP parsing/negotiation is official SDK. */
export async function startOfficialHttpFixture({ modern = true, json = false, paged = false, serverFactory = null } = {}) {
  const requests = [], active = new Set(), factory = serverFactory || (paged ? pagedFixtureServer : fixtureServer)
  const handler = modern ? createMcpHandler(factory) : null
  const sessions = new Map()
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks), message = body.length ? JSON.parse(body) : null
      requests.push({ method: req.method, rpc: message?.method, version: req.headers['mcp-protocol-version'], session: Boolean(req.headers['mcp-session-id']), userAgent: req.headers['user-agent'], client: req.headers['x-kk-code-client'] })
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) })
      let response
      if (handler) response = await handler.fetch(request)
      else {
        let transport = sessions.get(req.headers['mcp-session-id'])
        if (!transport && message?.method === 'initialize') {
          const instance = factory()
          transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: json, onsessioninitialized: id => sessions.set(id, transport) })
          active.add(instance); await instance.connect(transport)
        }
        response = transport ? await transport.handleRequest(request) : new Response('Legacy session required', { status: 400 })
      }
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body).pipe(res)
      else res.end()
    } catch { res.writeHead(500); res.end('Fixture request failed') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests, async close() { await handler?.close(); for (const instance of active) await instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(process.argv[2] === 'paged' ? pagedFixtureServer : process.argv[2] === 'repeated' ? () => pagedFixtureServer({ repeatCursor: true }) : fixtureServer)
  process.stdin.on('end', () => { void handle.close() })
}
