import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { createKernel, MODE_CYCLE, laneOf, approvalOf } from '../kernel/index.mjs'
import { PACKAGE_VERSION } from '../version.mjs'
import { redactSensitive } from '../http/identity.mjs'
import { requestAcpQuestion } from './elicitation.mjs'

const invalid = message => acp.RequestError.invalidParams({ message })
const modes = currentModeId => ({ currentModeId, availableModes: MODE_CYCLE.map(mode => ({ id: mode.id, name: mode.label, description: mode.hint })) })

/** One ACP connection owns its kernels and cancellation scope. No terminal UI. */
export function createAcpApp({ trust = false, createKernelImpl = createKernel } = {}) {
  const sessions = new Map(), active = new Map()
  let clientCapabilities = {}
  const app = acp.agent({ name: 'kkcode' })
  function session(id) { const found = sessions.get(id); if (!found) throw invalid('Load or create this session first'); return found }
  const notify = (client, id, update) => client.notify('session/update', { sessionId: id, update })
  async function open(ctx, loaded = false) {
    const { cwd, mcpServers = [], sessionId } = ctx.params
    if (sessionId && sessions.has(sessionId)) throw invalid('This session is already loaded in this connection')
    if (!path.isAbsolute(cwd) || sessions.size >= 32) throw invalid('Use an absolute workspace path; at most 32 sessions per connection')
    const directory = await realpath(cwd)
    let id = sessionId, entry
    const kernel = await createKernelImpl({ cwd: directory, boot: false, trust, handlers: {
      onOutput: () => {},
      onEvent: async event => {
        if (!entry || event.sessionId !== id) return
        const payload = event.payload || {}
        if (event.type === 'stream.text.delta') {
          entry.streamed = true
          await notify(entry.client, id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(payload.text || '') } })
        } else if (['tool.start', 'tool.finish', 'tool.error'].includes(event.type)) {
          const started = event.type === 'tool.start'
          await notify(entry.client, id, {
            sessionUpdate: started ? 'tool_call' : 'tool_call_update', toolCallId: String(payload.invocationId || event.id),
            title: String(payload.tool || 'Tool'), kind: 'other', status: started ? 'in_progress' : event.type === 'tool.error' ? 'failed' : 'completed',
            ...(started ? { rawInput: redactSensitive(payload.args || {}) } : { content: [{ type: 'content', content: { type: 'text', text: String(redactSensitive(payload.output || '')).slice(0, 20000) } }] })
          })
        }
      },
      onPermissionPrompt: async request => {
        const run = active.get(id)
        if (!run || run.signal.aborted) return 'deny'
        try {
          const result = await entry.client.request('session/request_permission', {
            sessionId: id, toolCall: { toolCallId: String(request.id || `permission-${Date.now()}`), title: String(request.tool || 'Approve operation'), status: 'pending', rawInput: redactSensitive(request) },
            options: [{ optionId: 'allow_once', kind: 'allow_once', name: '允许本次' }, { optionId: 'deny', kind: 'reject_once', name: '拒绝' }]
          }, { signal: run.signal })
          return result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow_once' ? 'allow_once' : 'deny'
        } catch { return 'deny' }
      },
      onQuestionPrompt: async request => {
        const run = active.get(id)
        if (!entry || !run || run.signal.aborted) return { cancelled: true }
        const answer = await requestAcpQuestion({ client: entry.client, capabilities: clientCapabilities, sessionId: id, request, signal: run.signal })
        if (answer !== null) return answer
        await notify(entry.client, id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `当前编辑器未声明支持 ACP 表单交互；本次输入请求已取消，未自动确认。请在聊天中补充信息：\n${JSON.stringify(redactSensitive(request.questions || request.question || '请补充任务信息'))}` } })
        return { cancelled: true }
      }
    } })
    try {
      if (mcpServers.length && !kernel.trustState.trusted) throw invalid('Trust this workspace before adding editor-provided MCP processes (kkcode acp --trust)')
      for (const server of mcpServers) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(server.name)) throw invalid('Invalid MCP server name')
        kernel.configState.config.mcp ||= {}; kernel.configState.config.mcp.servers ||= {}
        kernel.configState.config.mcp.servers[`acp_${server.name}`] = server.type === 'http' || server.type === 'sse'
          ? { transport: server.type === 'http' ? 'streamable-http' : 'legacy-sse', url: server.url, headers: Object.fromEntries((server.headers || []).map(header => [header.name, header.value])) }
          : { transport: 'stdio', command: [server.command, ...server.args], env: Object.fromEntries((server.env || []).map(variable => [variable.name, variable.value])), shell: false }
      }
      const config = kernel.configState.config, provider = config.provider.default, model = config.provider[provider]?.default_model || ''
      const previous = loaded ? await kernel.sessions.getSession(id) : null
      if (loaded && (!previous || await realpath(previous.session.cwd) !== directory)) throw invalid('Session does not belong to this workspace')
      id ||= kernel.turns.newSessionId()
      entry = { kernel, client: ctx.client, cwd: directory, mode: previous?.session.modeId || 'agent', model: previous?.session.model || model, provider: previous?.session.providerType || provider, streamed: false }
      if (!loaded) await kernel.sessions.touchSession({ sessionId: id, cwd: directory, model, providerType: provider, mode: 'assistant', status: 'idle' })
      sessions.set(id, entry)
      if (loaded) for (const message of previous.messages.slice(-200)) {
        if (message.synthetic || !['user', 'assistant'].includes(message.role)) continue
        const text = typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (text) await notify(ctx.client, id, { sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: text.slice(0, 20000) } })
      }
      return { ...(loaded ? {} : { sessionId: id }), modes: modes(entry.mode) }
    } catch (error) { if (sessions.get(id)?.kernel === kernel) sessions.delete(id); await kernel.shutdown(); throw error }
  }
  app.onRequest('initialize', ctx => {
    clientCapabilities = ctx.params.clientCapabilities || {}
    return { protocolVersion: acp.PROTOCOL_VERSION, agentInfo: { name: 'kkcode', title: 'KK Code', version: PACKAGE_VERSION }, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false }, mcpCapabilities: { http: true, sse: true } } }
  })
    .onRequest('session/new', ctx => open(ctx))
    .onRequest('session/load', ctx => open(ctx, true))
    .onRequest('session/set_mode', async ctx => {
      const entry = session(ctx.params.sessionId)
      if (active.has(ctx.params.sessionId) || !MODE_CYCLE.some(mode => mode.id === ctx.params.modeId)) throw invalid('Wait for the current turn and select an advertised mode')
      entry.mode = ctx.params.modeId
      await entry.kernel.sessions.updateSession(ctx.params.sessionId, { modeId: entry.mode })
      return {}
    })
    .onRequest('session/prompt', async ctx => {
      const id = ctx.params.sessionId, entry = session(id)
      if (active.has(id)) throw invalid('A turn is already active in this session')
      const contentBlocks = [], text = []
      for (const block of ctx.params.prompt) {
        if (block.type === 'text') text.push(block.text)
        else if (block.type === 'image') contentBlocks.push({ type: 'image', data: block.data, mediaType: block.mimeType })
        else throw invalid('This ACP adapter supports text and image inputs; other resource types are not advertised')
      }
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ctx.signal])
      active.set(id, { controller, signal }); entry.streamed = false; entry.client = ctx.client
      try {
        const configState = structuredClone(entry.kernel.configState)
        configState.config.permission = { ...configState.config.permission, level: approvalOf(entry.mode), auto_review: ['auto', 'ultra'].includes(entry.mode) }
        const prompt = text.join('\n')
        const pending = entry.kernel.executeTurn({ sessionId: id, prompt, ...(contentBlocks.length ? { contentBlocks: [...(prompt ? [{ type: 'text', text: prompt }] : []), ...contentBlocks] } : {}), mode: laneOf(entry.mode), model: entry.model, providerType: entry.provider, configState, signal, allowQuestion: true })
        active.get(id).promise = pending
        const result = await pending
        if (!entry.streamed && result.reply) await notify(ctx.client, id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.reply } })
        if (signal.aborted) return { stopReason: 'cancelled' }
        if (result.error) throw acp.RequestError.internalError({ message: String(redactSensitive(result.error)) })
        return { stopReason: 'end_turn' }
      } finally { active.delete(id) }
    })
    .onNotification('session/cancel', ctx => { active.get(ctx.params.sessionId)?.controller.abort() })
  async function shutdown() {
    for (const run of active.values()) run.controller.abort()
    await Promise.allSettled([...active.values()].map(run => run.promise))
    await Promise.allSettled([...sessions.values()].map(entry => entry.kernel.shutdown()))
    sessions.clear()
  }
  return { app, shutdown }
}

export async function runAcp({ trust = false, input = process.stdin, output = process.stdout } = {}) {
  const host = createAcpApp({ trust })
  const connection = host.app.connect(acp.ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)))
  try { await connection.closed } finally { await host.shutdown() }
}
