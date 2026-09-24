// Trusted helper. Executed only in a fixed-image, no-network container whose
// sole writable bind is a private dependency job, never the original repository.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readPinnedFile } from '../util/pinned-io.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const privateNames = new Set(['.git', '.kkcode', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', '.npmrc', '.pypirc', '.netrc', '.envrc', '.mcp.json', 'id_rsa', 'id_ed25519', 'credentials'])
const sensitive = name => privateNames.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name)
const input = JSON.parse(await new Promise(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { text += value; if (text.length > 4 * 1024 * 1024) process.exit(2) }); process.stdin.on('end', () => resolve(text)) }))
async function manifests() {
  const packageJson = await readPinnedFile('/workspace', 'package.json', { maxBytes: 2 * 1024 * 1024 })
  const packageLock = await readPinnedFile('/workspace', 'package-lock.json', { maxBytes: 4 * 1024 * 1024 })
  return { packageJson: packageJson.toString('base64'), packageLock: packageLock.toString('base64'), manifestHashes: { packageJson: hash(packageJson), packageLock: hash(packageLock) }, platform: { os: process.platform, arch: process.arch } }
}
async function seal() {
  const root = '/workspace/node_modules', digester = createHash('sha256'), inodes = new Map()
  let files = 0, bytes = 0
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Dependency directory required')
  async function walk(relative = '') {
    const dir = path.join(root, relative)
    for (const name of (await fs.readdir(dir)).sort()) {
      // Generic strict execution masks these names. Refuse them rather than
      // signing the masked empty view and later mounting different real bytes.
      if (sensitive(name)) throw new Error('Unsupported sensitive dependency path')
      const rel = relative ? `${relative}/${name}` : name, absolute = path.join(root, rel)
      if (++files > 200000 || /[\x00-\x1f\x7f\\]/.test(rel)) throw new Error('Dependency tree limit')
      const info = await fs.lstat(absolute)
      if (info.mode & 0o6000) throw new Error('Privileged dependency mode')
      if (info.isDirectory()) { digester.update(JSON.stringify([rel, 'dir', info.mode & 0o7777])); await walk(rel) }
      else if (info.isSymbolicLink()) {
        const target = await fs.readlink(absolute), resolved = await fs.realpath(absolute)
        if (!resolved.startsWith(`${root}/`) || /[\x00-\x1f\x7f]/.test(target)) throw new Error('External dependency link')
        digester.update(JSON.stringify([rel, 'link', target]))
      } else if (info.isFile()) {
        if (info.size > 64 * 1024 * 1024 || (bytes += info.size) > input.maxBytes) throw new Error('Dependency byte limit')
        const content = await fs.readFile(absolute), after = await fs.lstat(absolute)
        if (info.ino !== after.ino || info.dev !== after.dev || info.size !== content.length || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('Dependency changed')
        const key = `${info.dev}:${info.ino}`, record = inodes.get(key) || { found: 0, links: info.nlink }
        record.found++; inodes.set(key, record)
        digester.update(JSON.stringify([rel, 'file', info.mode & 0o7777, hash(content)]))
      } else throw new Error('Special dependency file')
    }
  }
  await walk()
  for (const value of inodes.values()) if (value.links !== value.found) throw new Error('External dependency hard link')
  return { treeHash: digester.digest('hex'), files, bytes }
}
async function scripts() {
  for (const item of input.scripts) {
    if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(item.path) || item.path.split('/').some(part => part.startsWith('.')) || !['preinstall', 'install', 'postinstall'].includes(item.event)) throw new Error('Invalid lifecycle scope')
    const absolute = `/workspace/${item.path}`, manifest = JSON.parse((await readPinnedFile('/workspace', `${item.path}/package.json`, { maxBytes: 262144 })).toString('utf8'))
    if (manifest.scripts?.[item.event] !== item.command || hash(item.command) !== item.sha256) throw new Error('Lifecycle changed')
    await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', 'ulimit -S -f 65536 || exit 125; ulimit -H -f 65536 || exit 125; exec /bin/sh -c "$1"', 'kk-offline-hook', item.command], { cwd: absolute, stdio: ['ignore', 'pipe', 'pipe'], env: {
        HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', CI: '1',
        PATH: `${absolute}/node_modules/.bin:/workspace/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
        npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: '/tmp/npm-cache',
        npm_config_userconfig: '/tmp/kk-empty-user-config', npm_config_globalconfig: '/tmp/kk-empty-global-config', npm_lifecycle_event: item.event,
        npm_package_name: manifest.name || '', npm_package_version: manifest.version || ''
      } })
      let size = 0
      const output = chunk => { size += chunk.length; if (size > 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Lifecycle output limit')) } }
      child.stdout.on('data', output); child.stderr.on('data', output)
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(undefined) : reject(new Error('Offline lifecycle failed')))
    })
  }
  // Some approved installers (notably esbuild) optimize binaries with internal
  // hard links. Prove every link stays in node_modules, then materialize copies
  // inside this same isolated job so later host mount inspection can reject all
  // hard links without special-case trust or exposing an outside inode.
  await seal()
  async function materialize(dir) {
    for (const name of await fs.readdir(dir)) {
      const target = path.join(dir, name), info = await fs.lstat(target)
      if (info.isDirectory()) await materialize(target)
      else if (info.isFile() && info.nlink > 1) {
        const temporary = path.join(dir, `.kk-copy-${randomUUID()}`)
        await fs.copyFile(target, temporary); await fs.chmod(temporary, info.mode & 0o777); await fs.rename(temporary, target)
      }
    }
  }
  await materialize('/workspace/node_modules')
  return { completed: input.scripts.length }
}
try {
  const result = input.operation === 'collect' ? await manifests() : input.operation === 'seal' ? await seal() : input.operation === 'scripts' ? await scripts() : null
  if (!result) throw new Error('Unsupported helper operation')
  process.stdout.write(JSON.stringify({ ok: true, ...result }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
