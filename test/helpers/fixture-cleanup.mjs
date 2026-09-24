import { rm } from 'node:fs/promises'

/** One after hook owns the fixture: dependent resources drain in reverse
 * acquisition order, then directories are removed. A failed release still
 * attempts every other release, but never deletes possibly-live state. */
export function createFixtureCleanup(t) {
  const releases = [], directories = new Set()
  let closing
  const cleanup = {
    defer(release) {
      if (closing) throw new Error('Fixture cleanup already started')
      releases.push(release)
    },
    own(resource, release = value => value.close()) {
      cleanup.defer(() => release(resource))
      return resource
    },
    remove(directory) {
      if (closing) throw new Error('Fixture cleanup already started')
      directories.add(directory)
    },
    close() {
      closing ??= (async () => {
        const failures = []
        for (const release of [...releases].reverse()) {
          try { await release() } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, 'Fixture resources did not release; temporary state was retained')
        for (const directory of directories) await rm(directory, { recursive: true, force: true })
      })()
      return closing
    }
  }
  t.after(() => cleanup.close())
  return cleanup
}
