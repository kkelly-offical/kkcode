import { sessionCommands } from '../repl/commands/session.mjs'
import { providerCommands } from '../repl/commands/provider.mjs'
import { permissionCommands } from '../repl/commands/permission.mjs'
import { modeCommands } from '../repl/commands/mode.mjs'
import { authoringCommands } from '../repl/commands/authoring.mjs'
export const BUILTIN_COMMANDS = [...sessionCommands, ...providerCommands, ...permissionCommands, ...modeCommands, ...authoringCommands]
export const DEVICE_COMMAND_HANDLERS = Object.freeze({
  exit: 'client', clear: 'client', keys: 'client', theme: 'client', paste: 'client', like: 'client', profile: 'client',
  dash: 'client', history: 'sessions', resume: 'sessions', new: 'sessions',
  provider: 'selection', model: 'selection', mode: 'selection', assistant: 'selection', agent: 'selection', code: 'selection', coding: 'selection', auto: 'selection', yolo: 'selection', plan: 'selection', ultra: 'selection', longagent: 'selection',
  session: 'shared', btw: 'shared', status: 'shared', compact: 'shared', undo: 'shared', rewind: 'shared', board: 'shared',
  trust: 'shared', untrust: 'shared', permission: 'shared', help: 'shared', commands: 'shared', reload: 'shared', mcp: 'shared', agents: 'shared', tasks: 'shared', skills: 'shared', 'create-skill': 'shared', 'create-agent': 'shared'
})
export const COMMAND_CLIENT_ACTIONS = Object.freeze(['exit', 'clear', 'keys', 'theme', 'paste', 'profile', 'like', 'home', 'sessions', 'session', 'models', 'provider', 'mode', 'permission'])
export function publicCommandCatalog() {
  return BUILTIN_COMMANDS.map(entry => ({ name: entry.names[0], aliases: entry.names.slice(1), description: entry.desc, arguments: entry.argMode || 'none', kind: DEVICE_COMMAND_HANDLERS[entry.names[0]] === 'client' ? 'client' : 'device' }))
}
