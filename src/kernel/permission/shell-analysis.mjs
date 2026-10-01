/**
 * Conservative lexical analysis, never a shell evaluator. Consumers must treat
 * `uncertain`/`dynamic` as unknown, not as proof that a command is read-only.
 * Words are unquoted; redirects belong only to their own simple command.
 */
export function parseShellCommands(input) {
  const source = String(input || '')
  const commands = []
  let words = [], redirects = [], word = '', hasWord = false, quote = '', dynamic = false, glob = false
  let uncertain = false, pendingRedirect = null
  const flushWord = () => {
    if (!hasWord) return
    if (pendingRedirect) {
      redirects.push({ operator: pendingRedirect, target: word })
      pendingRedirect = null
    } else words.push(word)
    word = ''; hasWord = false
  }
  const flushCommand = (separator = null) => {
    flushWord()
    if (pendingRedirect) { uncertain = true; pendingRedirect = null }
    if (words.length || redirects.length) commands.push({ words, redirects, dynamic, glob, separator })
    else if (separator && !['\n', '\r'].includes(separator)) uncertain = true
    words = []; redirects = []; dynamic = false; glob = false
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      else word += c
      continue
    }
    if (c === '\\') {
      if (i + 1 >= source.length) { uncertain = true; continue }
      const next = source[++i]
      if (next !== '\n') { word += next; hasWord = true }
      continue
    }
    if (c === '"') { quote = quote === '"' ? '' : '"'; hasWord = true; continue }
    if (!quote && c === "'") { quote = "'"; hasWord = true; continue }
    if (c === '$' || c === '`') { dynamic = true; uncertain = true }
    if (quote) { word += c; hasWord = true; continue }
    if (c === '*' || c === '?' || c === '[') glob = true
    if (c === '#' && !hasWord) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++
      continue
    }
    if (c === '<' || c === '>') {
      // A numeric word immediately before a redirect is its file descriptor.
      if (hasWord && /^\d+$/.test(word)) { word = ''; hasWord = false }
      flushWord()
      if (pendingRedirect) uncertain = true
      let operator = c
      if (source[i + 1] === c || source[i + 1] === '&' || source[i + 1] === '|') operator += source[++i]
      if (operator === '<<') { uncertain = true; if (source[i + 1] === '<' || source[i + 1] === '-') operator += source[++i] }
      pendingRedirect = operator
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      const separator = source[i + 1] === c ? c + source[++i] : c
      flushCommand(separator)
      continue
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      uncertain = true
      flushCommand()
      continue
    }
    if (/\s/.test(c)) { flushWord(); continue }
    word += c; hasWord = true
  }
  if (quote) uncertain = true
  flushCommand()
  return { commands, uncertain }
}

const NONMUTATING_PROGRAMS = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'which', 'whoami', 'uname', 'grep', 'echo', 'printf', 'true'])

/** Effect knowledge is NOT execution authorization. A compound expression may
 * remain risky-shell for approvals/scope while its literal read-only leaves do
 * not invalidate a project check. Assumes the same trusted inherited execution
 * environment as basic shell classification, not an executable attestation or
 * OS sandbox. Never infer safety for scripts, configuration-loading programs,
 * substitutions, redirects, custom environments or unjoined background jobs. */
export function isLiteralNonmutatingShell(input, {env = null} = {}) {
  if (env != null && (typeof env !== 'object' || Array.isArray(env) || Reflect.ownKeys(env).length)) return false
  const command = String(input || '').trim()
  // Restrict the additional composition proof to the common literal subset
  // of /bin/sh and ComSpec. CMD does not honor POSIX single quotes/backslash
  // escapes and can expand %, ! and ^; these remain conservative/opaque.
  if (/[\\'%!^]/.test(command)) return false
  const parsed = parseShellCommands(command)
  if (parsed.uncertain || !parsed.commands.length || parsed.commands.length > 32) return false
  return parsed.commands.every((entry, index) => {
    if (entry.dynamic || entry.glob || entry.redirects.length || !entry.words.length) return false
    if (index === parsed.commands.length - 1 ? entry.separator !== null : !['&&', '||', '|', ';', '\n', '\r'].includes(entry.separator)) return false
    const [program, ...args] = entry.words
    if (NONMUTATING_PROGRAMS.has(program)) return true
    if (program !== 'cd' || entry.separator === '|') return false
    const directory = args[0] === '--' ? args.slice(1) : args
    return directory.length === 1 && directory[0] && !directory[0].startsWith('-') && !directory[0].startsWith('~')
  })
}
