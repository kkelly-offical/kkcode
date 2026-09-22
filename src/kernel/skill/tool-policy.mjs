import { matchGlob } from '../../util/glob.mjs'

const canonical = name => ({ Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash', Glob: 'glob', Grep: 'grep', Agent: 'task', Task: 'task', WebFetch: 'webfetch', WebSearch: 'websearch' })[name] || name

/** Restrictions intersect; a skill can narrow tool use, never pre-approve it. */
export function createSkillToolPolicy(initial = null, inherited = []) {
  const groups = []
  const add = rules => {
    if (rules == null) return
    if (!Array.isArray(rules) || rules.length > 128 || rules.some(rule => typeof rule !== 'string' || !rule.trim() || rule.length > 256)) throw new Error('Skill allowed-tools must be a bounded list of tool patterns')
    groups.push([...rules])
  }
  add(initial)
  if (!Array.isArray(inherited) || inherited.length > 128) throw new Error('Too many inherited skill tool policies')
  for (const group of inherited) add(group)
  const allows = (name, args = {}, nameOnly = false) => groups.every(rules => rules.some(rule => {
    const match = /^([^()]+)(?:\(([^()]*)\))?$/.exec(rule.trim())
    if (!match || !matchGlob(name, canonical(match[1]))) return false
    if (!match[2] || nameOnly) return true
    const pattern = match[2].replace(/:\*$/, ' *')
    const target = String(args.command ?? args.path ?? args.pattern ?? args.skill ?? '')
    if (name === 'bash' && pattern !== '*' && /[;&|\n\r`$<>]/.test(target)) return false
    return matchGlob(target, pattern) || match[2].endsWith(':*') && target === match[2].slice(0, -2)
  }))
  return { add, allows, snapshot: () => groups.map(rules => [...rules]), names: tools => tools.filter(tool => allows(tool.name, {}, true)).map(tool => tool.name) }
}
