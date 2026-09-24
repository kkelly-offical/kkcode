const categories = new Set(['repository', 'recovery', 'safety', 'documents'])
const fail = () => { throw new Error('Invalid evaluation check projection input') }

/** Public sealed diagnostics expose structure and outcomes, never oracle text.
 * Raw host evidence is deliberately non-enumerable: serializing/spreading this
 * object cannot accidentally publish the private checks. Persist privateChecks
 * only in the evaluator's mode-0600 control directory, outside model workspaces. */
export function projectEvaluationChecks({ split, category, checks } = {}) {
  if (!['development', 'sealed'].includes(split) || !categories.has(category)
    || !Array.isArray(checks) || checks.length > 1000) fail()
  const outcomes = checks.map(check => {
    if (!check || typeof check !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(check))) fail()
    const passed = Object.getOwnPropertyDescriptor(check, 'passed')
    const name = Object.getOwnPropertyDescriptor(check, 'name')
    if (!passed || !Object.hasOwn(passed, 'value') || typeof passed.value !== 'boolean'
      || !name || !Object.hasOwn(name, 'value') || typeof name.value !== 'string') fail()
    return passed.value
  })
  let raw
  try { raw = structuredClone(checks) } catch { fail() }
  const publicChecks = split === 'sealed'
    ? outcomes.map((passed, index) => Object.freeze({ ordinal: index + 1, name: `check-${String(index + 1).padStart(3, '0')}`, passed, category }))
    : structuredClone(raw)
  Object.freeze(publicChecks)
  const projection = { publicChecks }
  Object.defineProperty(projection, 'privateChecks', { enumerable: false, get: () => structuredClone(raw) })
  return Object.freeze(projection)
}
