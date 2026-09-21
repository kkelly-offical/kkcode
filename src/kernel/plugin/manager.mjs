import path from 'node:path'
import { mkdtemp, mkdir, readdir, readFile, cp, rename, rm, lstat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pacote from 'pacote'
import { userRootDir } from '../../storage/paths.mjs'
import { readJson, writeJsonAtomic } from '../../storage/json-store.mjs'

const run = promisify(execFile)
const pluginName = name => { if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) throw new Error('Plugin name must use lowercase letters, numbers, - or _'); return name }
async function rejectLinks(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === '.git') continue
    const target = path.join(dir, item.name), info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error('Portable plugins may not contain symbolic links')
    if (info.isDirectory()) await rejectLinks(target)
  }
}
export async function installPlugin({ name, source, revision, update = false }) {
  name = pluginName(name)
  const root = path.join(userRootDir(), 'plugins')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(path.join(root, '.install-')), payload = path.join(staging, 'payload'), target = path.join(root, name)
  let backup
  try {
    if (source.startsWith('npm:')) {
      const spec = source.slice(4)
      if (!/@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(spec)) throw new Error('npm plugins require an exact version')
      await pacote.extract(spec, payload, { ignoreScripts: true })
    } else if (/^https:\/\/.+\.git$/.test(source)) {
      if (!/^[a-fA-F0-9]{40}$/.test(revision || '')) throw new Error('Git plugins require a full commit SHA')
      await run('git', ['clone', '--no-checkout', '--', source, payload], { timeout: 120000 })
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', revision], { cwd: payload, timeout: 120000 })
    } else {
      await rejectLinks(path.resolve(source))
      await cp(path.resolve(source), payload, { recursive: true, filter: src => path.basename(src) !== '.git' })
    }
    await rejectLinks(payload)
    let manifest, manifestFile
    for (const candidate of ['plugin.json', '.kkcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      try { manifest = JSON.parse(await readFile(path.join(payload, candidate), 'utf8')); manifestFile = candidate; break } catch { /* try next portable layout */ }
    }
    if (!manifest || typeof manifest.name !== 'string') throw new Error('A supported plugin.json manifest with a name is required')
    const current = await readJson(path.join(target, 'plugin.json'), null)
    if (current && !update) throw new Error('Plugin exists; use plugin update')
    const portable = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].includes(manifestFile)
    // Managed plugins are normalized to a root manifest. Preserve the portable
    // default skill locations that would otherwise disappear with that move.
    const safe = { ...manifest, name, enabled: current ? current.enabled !== false : true, ...(portable && manifest.skills === undefined && manifest.components?.skills === undefined ? { skills: ['./skills', './'] } : {}) }
    await writeJsonAtomic(path.join(payload, 'plugin.json'), safe)
    if (current) { backup = path.join(staging, 'previous'); await rename(target, backup) }
    await rename(payload, target)
    await writeJsonAtomic(path.join(target, 'kkcode-install.json'), { source, revision: revision || null, installedAt: Date.now(), version: manifest.version || null })
    return { name, version: manifest.version, installed: true }
  } catch (error) {
    if (backup) { await rm(target, { recursive: true, force: true }); await rename(backup, target) }
    throw error
  } finally { await rm(staging, { recursive: true, force: true }) }
}
export async function managePlugin(name, action) {
  const root = path.join(userRootDir(), 'plugins'), target = path.join(root, pluginName(name))
  const manifest = await readJson(path.join(target, 'plugin.json'), null)
  if (!manifest) throw new Error('Managed plugin not found')
  if (action === 'update') {
    const install = await readJson(path.join(target, 'kkcode-install.json'), null)
    if (!install) throw new Error('Plugin has no recorded install source')
    return installPlugin({ name, ...install, update: true })
  }
  if (action === 'remove') {
    const trash = path.join(userRootDir(), 'plugin-trash')
    await mkdir(trash, { recursive: true, mode: 0o700 })
    await rename(target, path.join(trash, `${name}-${Date.now()}`))
    return { name, removed: true, recoverable: true }
  }
  if (!['enable', 'disable'].includes(action)) throw new Error('Unknown plugin action')
  manifest.enabled = action === 'enable'; await writeJsonAtomic(path.join(target, 'plugin.json'), manifest)
  return { name, enabled: manifest.enabled }
}
