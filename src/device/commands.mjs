import path from 'node:path'
import { BUILTIN_COMMANDS, DEVICE_COMMAND_HANDLERS, publicCommandCatalog } from '../command/builtin.mjs'
import { resolveCommand, splitCommandLine } from '../repl/commands/registry.mjs'
import { normalizeSlashAlias } from '../repl/slash-router.mjs'
import { switchModeInPlace, MODE_PICKER_CHOICES } from '../repl/mode-flow.mjs'
import { POLICY_CHOICES } from '../repl/permission-flow.mjs'
import { loadCustomCommands, applyCommandTemplate } from '../command/custom-commands.mjs'
import { modeIdFromLegacy, approvalOf } from '../kernel/index.mjs'
import { DEFAULT_THEME } from '../theme/default-theme.mjs'
import { ProtocolError } from '../protocol/index.mjs'
import { getDeviceProfile } from './profile.mjs'
export { publicCommandCatalog }

const stripAnsi = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
const modeCommands = new Set(['mode', 'assistant', 'agent', 'code', 'coding', 'yolo', 'plan', 'ultra', 'longagent'])

function configuredProviders(config) {
  return Object.entries(config.provider || {}).filter(([key, value]) => key !== 'default' && value && typeof value === 'object' && !Array.isArray(value) && (value.type || value.base_url || value.default_model)).map(([key]) => key)
}

export async function listDeviceCommands({ kernel }) {
  await kernel.bootExtensions()
  const commands = publicCommandCatalog(), names = new Set(commands.flatMap(c => [c.name, ...c.aliases]))
  const custom = await loadCustomCommands(kernel.cwd, { allowProjectSources: kernel.extensionPolicy.allowProjectSources })
  const skills = kernel.extensions.skills.isReady() ? kernel.extensions.skills.list() : []
  for (const item of [...custom, ...skills]) {
    if (names.has(item.name)) continue
    names.add(item.name)
    commands.push({ name: item.name, aliases: [], description: item.description || `custom (${item.scope || item.type || 'skill'})`, arguments: 'optional', kind: 'device', source: item.scope || 'skill' })
  }
  return commands
}

/** One transport-neutral dispatcher: never start readline or silently discard a picker. */
export async function runDeviceCommand({ service, kernel, sessionId, command, principal }) {
  if (typeof command !== 'string' || !command.trim() || command.length > 200000) throw new ProtocolError('invalid_command', 'Command must contain 1–200000 characters')
  const input = command.trim()
  const normalized = normalizeSlashAlias(input.startsWith('/') || input.startsWith('$') ? input : `/${input}`)
  const hit = resolveCommand(normalized, BUILTIN_COMMANDS)
  const parts = splitCommandLine(normalized)
  if (!hit && BUILTIN_COMMANDS.some(entry => entry.names.includes(parts?.name))) throw new ProtocolError('invalid_command', 'Invalid command arguments')
  const name = hit?.entry.names[0], args = hit?.args || ''
  if (name && !DEVICE_COMMAND_HANDLERS[name]) throw new ProtocolError('unsupported_command', `No remote handler is registered for /${name}`)
  const response = { output: [], panels: [] }
  const action = (clientAction, extra = {}) => ({ ...response, clientAction, args, ...extra })
  if (['exit', 'clear', 'keys', 'paste'].includes(name)) return action(name)
  if (name === 'theme') {
    if (args && !['dark', 'light', 'auto'].includes(args)) throw new ProtocolError('invalid_theme', 'Use dark, light or auto')
    return action('theme')
  }
  if (name === 'profile' || name === 'like') return action(name, { preferences: await getDeviceProfile(), profile: service.metadata.profile || null })
  if (name === 'dash') return action('home')

  const saved = (await kernel.sessions.getSession(sessionId))?.session || {}
  const providerType = saved.providerType || kernel.configState.config.provider.default
  const state = { sessionId, mode: saved.mode || 'assistant', modeId: saved.modeId || 'agent', model: saved.model || kernel.configState.config.provider[providerType]?.default_model || '', providerType, ...service.commandStates.get(sessionId) }
  const configure = async values => {
    const configured = await service.dispatch('sessions.configure', { sessionId, ...values }, principal)
    Object.assign(state, configured)
    return { ...response, state: configured }
  }
  const start = (prompt, extra = {}) => service.dispatch('turns.start', { sessionId, prompt, ...extra }, principal)
  const providerNames = configuredProviders(kernel.configState.config)

  if (name === 'new') {
    const created = await service.dispatch('sessions.create', { cwd: kernel.cwd }, principal)
    await service.dispatch('control.acquire', { sessionId: created.id }, principal)
    let selection
    try {
      selection = await service.dispatch('sessions.configure', { sessionId: created.id, provider: state.providerType, ...(state.model ? { model: state.model } : {}), mode: state.modeId, ...(state.approval || saved.approval ? { approval: state.approval || saved.approval } : {}) }, principal)
    } finally { await service.dispatch('control.release', { sessionId: created.id }, principal) }
    return action('session', { sessionId: created.id, cwd: created.cwd, state: selection })
  }
  if (name === 'history' || name === 'resume') {
    const sessions = await kernel.sessions.listSessions({ cwd: kernel.cwd, limit: 200, includeChildren: false })
    const items = sessions.map(s => ({ id: s.id, label: s.title || s.id, desc: `${s.mode || 'assistant'} · ${s.status || 'idle'}`, cwd: s.cwd }))
    if (!args) return action('sessions', { items })
    const matches = /^\d+$/.test(args) && Number(args) > 0 && Number(args) <= sessions.length
      ? [sessions[Number(args) - 1]] : sessions.filter(s => s.id === args || s.id.startsWith(args))
    if (matches.length !== 1) throw new ProtocolError(matches.length ? 'ambiguous_session' : 'session_missing', matches.length ? 'Session prefix matches more than one session' : 'Session not found', 404)
    return action('session', { sessionId: matches[0].id, cwd: matches[0].cwd })
  }
  if (name === 'provider') {
    if (!args || args === 'add' || args === 'edit' || args.startsWith('edit ')) {
      const editing = args.startsWith('edit ') ? args.slice(5).trim() : ''
      if (editing && !providerNames.includes(editing)) throw new ProtocolError('unknown_provider', 'Provider not found')
      return action('provider', { provider: editing || state.providerType, items: providerNames.map(id => ({ id, label: id })) })
    }
    if (args === 'set') return action('provider', { args: 'add' })
    if (!providerNames.includes(args)) throw new ProtocolError('unknown_provider', 'Configure this provider before selecting it')
    return configure({ provider: args })
  }
  if (name === 'model') {
    if (args && args !== 'refresh') return configure({ model: args })
    const catalog = await service.dispatch('models.discover', { provider: state.providerType, refresh: args === 'refresh' }, principal)
    return action('models', { catalog, provider: state.providerType })
  }
  if (modeCommands.has(name)) {
    if (name === 'mode' && !args) return action('mode', { current: state.modeId, items: MODE_PICKER_CHOICES.map(item => ({ id: item.value, label: stripAnsi(item.label), desc: item.desc })) })
    const mode = modeIdFromLegacy(name === 'mode' ? args : name)
    if (!mode) throw new ProtocolError('invalid_mode', 'Unknown execution mode')
    if (['ultra', 'longagent'].includes(name) && ['4stage', 'hybrid'].includes(args.toLowerCase())) throw new ProtocolError('invalid_command', 'Ultra uses one orchestration flow; this legacy subcommand was removed')
    await configure({ mode })
    if (['plan', 'ultra', 'longagent'].includes(name) && args) {
      const prompt = name === 'plan' ? ['Create a read-only development plan for this request.', 'Do not edit project source files. Inspect the repository as needed, then call enter_plan and exit_plan with the complete plan.', 'The plan must include goal, scope, implementation steps, impacted modules, tests, risks, and acceptance criteria.', '', `Request: ${args}`].join('\n') : args
      return { ...await start(prompt, { mode }), state }
    }
    return { ...response, state }
  }

  await kernel.bootExtensions()
  let customCommands = await loadCustomCommands(kernel.cwd, { allowProjectSources: kernel.extensionPolicy.allowProjectSources })
  if (!hit) {
    const [invoked, ...tokens] = normalized.slice(1).split(/\s+/), argument = tokens.join(' ')
    const registry = kernel.extensions.skills
    const skill = registry.isReady() ? registry.get(invoked) : null
    let prompt
    if (skill) {
      const expanded = await kernel.run(() => registry.execute(invoked, argument, { cwd: kernel.cwd, mode: state.mode, model: state.model, provider: state.providerType, config: kernel.configState.config }))
      prompt = typeof expanded === 'object' ? expanded?.prompt : expanded
      if (expanded?.model) await configure({ model: expanded.model })
    } else {
      const custom = normalized.startsWith('$') ? null : customCommands.find(item => item.name === invoked)
      if (!custom) throw new ProtocolError('unknown_command', 'Unknown command or skill')
      prompt = applyCommandTemplate(custom.template, argument, { path: kernel.cwd, cwd: kernel.cwd, project: path.basename(kernel.cwd), mode: state.mode, provider: state.providerType })
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ProtocolError('empty_command', 'Command returned no prompt')
    return start(prompt)
  }

  const print = (text, options = {}) => response.output.push({ text: stripAnsi(text), ...options })
  const panel = (title, text) => response.panels.push({ title: stripAnsi(title), text: stripAnsi(typeof text === 'function' ? text(90) : text) })
  const ctx = { kernel, configState: structuredClone(kernel.configState), trustState: kernel.trustState, themeState: { theme: DEFAULT_THEME }, profile: service.metadata.profile, remoteService: service }
  ctx.configState.config.permission.level = state.approval || saved.approval || approvalOf(state.modeId)
  const outcome = await kernel.run(() => hit.entry.run({
    line: normalized, normalized, name: hit.name, args, state, ctx, print,
    showInfo: panel, openPanel: panel, providersConfigured: providerNames, customCommands,
    setCustomCommands: list => { customCommands = list }, switchModeInPlace,
    runPromptTurn: ({ prompt }) => start(prompt)
  }))
  if (name === 'permission') {
    kernel.configState.config.permission = ctx.configState.config.permission
    if (!['', 'show', 'list', 'rules'].includes(args)) await configure({ approval: ctx.configState.config.permission.level })
  }
  if (outcome?.openPolicyPicker) return action('permission', { current: ctx.configState.config.permission.level, items: POLICY_CHOICES.map(item => ({ id: item.value, label: item.label, desc: item.desc })) })
  if (outcome?.rewound) return action('session', { sessionId, cwd: kernel.cwd, draft: outcome.rewound.prompt || '' })
  if (outcome?.rewrite) return { ...response, ...await start(outcome.rewrite) }
  if (Object.keys(outcome || {}).some(key => /^open.*Picker$/.test(key))) throw new ProtocolError('unsupported_command_action', 'This command returned an unmapped picker')
  return { ...response, state, action: outcome || {} }
}
