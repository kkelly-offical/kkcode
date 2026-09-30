import { parseShellCommands } from './shell-analysis.mjs'
import { trustedBashCommand } from './rules.mjs'
import { prepareControlledGitInvocation } from '../../util/controlled-git.mjs'

/** @param {string} command @param {Record<string, any>} [args] */
export function readonlyGitArgs(command, args = {}) {
  if (!trustedBashCommand(command, args)) return null
  const words = parseShellCommands(String(command || '').trim()).commands[0]?.words || []
  return words[0] === 'git' ? words.slice(1) : null
}

/** Host adapter for an already classified read-only Git command. The returned
 * executable/argv/env must be used as one invocation; never merge ambient env
 * or caller overrides back in. No shell, filters or configured helpers run
 * during preparation (only host-controlled Git config key inspection).
 * @param {string} command
 * @param {Record<string, any>} args
 * @param {{cwd: string, signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function safeGitReadInvocation(command, args, { cwd, signal, timeoutMs = 30000 }) {
  const argv = readonlyGitArgs(command, args)
  return argv ? prepareControlledGitInvocation(argv, { cwd, signal, timeoutMs }) : null
}
