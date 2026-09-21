import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { releaseWorkspacePaths, validateReleaseManifests } from './release-policy.mjs'

export async function checkReleaseVersions(root = new URL('../', import.meta.url)) {
  const base = root instanceof URL ? root : pathToFileURL(path.resolve(root) + path.sep)
  const read = async file => JSON.parse(await readFile(new URL(file, base), 'utf8'))
  const [manifest, lockfile] = await Promise.all([read('package.json'), read('package-lock.json')])
  const workspaces = Object.fromEntries(await Promise.all(releaseWorkspacePaths(manifest).map(async directory => [directory, await read(`${directory}/package.json`)])))
  return validateReleaseManifests(manifest, lockfile, workspaces)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const checked = await checkReleaseVersions()
  console.log(`release version policy ok: ${checked.version} (${checked.workspaces.length} workspaces, npm ${checked.distTag})`)
}
