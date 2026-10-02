import { cp, lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

/** Copy an administrator-owned immutable template into a fresh task directory.
 * npm's relative .bin links must stay relative: fs.cp's default rebases them to
 * the original template, giving test runners two different module instances.
 * This is not an atomic snapshot of a concurrently editable source tree. */
export async function copyDependencyTemplate(source, destination) {
  const root = await realpath(source)
  if (!(await lstat(root)).isDirectory()) throw new Error('DEPENDENCY_TEMPLATE_NOT_DIRECTORY')
  const target = path.resolve(destination)
  const info = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  if (info) throw new Error('DEPENDENCY_DESTINATION_EXISTS')
  const inside = value => { const relative = path.relative(root, value); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
  if (inside(target)) throw new Error('DEPENDENCY_DESTINATION_INSIDE_SOURCE')
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const link = await readlink(file)
        if (path.isAbsolute(link) || !inside(path.resolve(directory, link)) || !inside(await realpath(file))) throw new Error('DEPENDENCY_TEMPLATE_EXTERNAL_LINK')
      } else if (entry.isDirectory()) await inspect(file)
      else if (!entry.isFile()) throw new Error('DEPENDENCY_TEMPLATE_SPECIAL_FILE')
    }
  }
  await inspect(root)
  await cp(root, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, force: false, errorOnExist: true })
  return target
}
