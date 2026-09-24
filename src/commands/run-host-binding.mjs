import { createHash } from 'node:crypto'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

/** Only fields that govern execution. Revisions, delivery attempts, recovery
 * observations and display confirmation IDs must not change the authority. */
export function runHostBindingHash(meta) {
  const fields = ['sourceCwd', 'workspace', 'baseRevision', 'image', 'acceptance', 'networkOrigins', 'taskGraph', 'limits', 'actor', 'dependencyEnvironment']
  return createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(fields.map(key => [key, meta[key] ?? null]))))).digest('hex')
}
