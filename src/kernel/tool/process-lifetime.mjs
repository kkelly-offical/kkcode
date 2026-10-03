import {parseShellCommands} from '../permission/shell-analysis.mjs'

/** A service launches one literal foreground program. Replacing the POSIX
 * wrapper keeps its natural exit status authoritative during graceful stop. */
export function serviceCommand(command, {platform = process.platform} = {}) {
  const parsed = parseShellCommands(command)
  if (parsed.uncertain || parsed.commands.length !== 1 || parsed.commands[0].dynamic || parsed.commands[0].glob || parsed.commands[0].separator || parsed.commands[0].redirects.length) {
    throw new Error('A managed service requires one literal command, without shell operators, expansions or redirections. Use cwd/env parameters and a foreground startup script.')
  }
  const words = parsed.commands[0].words
  if (!words.length || words.every(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) throw new Error('A service executable is required')
  if (platform === 'win32') return command
  const quote = word => "'" + word.replaceAll("'", "'\\''") + "'"
  return 'exec ' + (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) ? 'env ' : '') + words.map(quote).join(' ')
}

/** Waiting is not a process deadline. Every process still has a finite lease. */
export function processLifetime(args = {}, config = {}) {
  const service = args.lifetime === 'service'
  if (args.lifetime != null && !['command', 'service'].includes(args.lifetime)) throw new Error('lifetime must be command or service')
  const configured = Number(config.tool?.bash_timeout_ms)
  const fallback = service ? 600000 : Number.isFinite(configured) && configured > 0 ? configured : 120000
  const max = service ? 3600000 : 600000
  if (args.yield_time_ms != null && (!Number.isFinite(args.yield_time_ms) || args.yield_time_ms < 0)) throw new Error('yield_time_ms must be a finite nonnegative number')
  const requested = Number(args.timeout)
  const timeoutMs = Math.min(Math.max(Number.isFinite(requested) && requested !== 0 ? requested : fallback, 1000), max)
  const yielding = service || args.run_in_background === true || args.yield_time_ms != null
  const waitMs = args.yield_time_ms == null ? service ? 1000 : 0 : Math.min(30000, Math.max(0, Number(args.yield_time_ms) || 0))
  return {service, yielding, timeoutMs, waitMs, lifetime: service ? 'service' : 'command'}
}

/** Bounded incremental projection; the cursor counts retained log entries,
 * never claims that a missing/evicted prefix was observed. */
export function processLogWindow(task, cursor = 0) {
  const lines = Array.isArray(task.logs) ? task.logs : []
  const end = Number.isSafeInteger(task.logSequence) ? task.logSequence : lines.length
  const start = Math.max(0, end - lines.length)
  const requested = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
  return {cursor: end, truncated: requested < start, reset: requested > end,
    output: lines.slice(Math.max(0, (requested > end ? start : requested) - start)).join('\n')}
}
