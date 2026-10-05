#!/usr/bin/env node
import { readFile, writeFile, readdir, lstat, realpath, mkdir, mkdtemp, rename, rm, chmod, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }
const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1]
  if (!['--target', '--rollback'].includes(flag) || !value || options.has(flag)) fail('Usage: node apply.mjs --target /path/to/kkcode [--rollback /path/to/backup]')
  options.set(flag, value)
}
if (!options.has('--target')) fail('--target must name the installed KK Code package directory')
const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
if (manifest.schema !== 1 || manifest.kind !== 'kkcode-web-display' || !/^1\.0\.\d+$/.test(manifest.baseVersion)) fail('Invalid display patch manifest')
function entries(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 4096) fail('Invalid display file list')
  const result = new Map()
  for (const row of rows) {
    if (typeof row.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(row.path) || row.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0 || result.has(row.path)) fail('Invalid display file entry')
    result.set(row.path, row)
  }
  if (!result.has('index.html')) fail('Missing Web entrypoint')
  return result
}
const files = entries(manifest.files), baseFiles = entries(manifest.baseFiles)
const target = await realpath(resolve(options.get('--target')))
const packageInfo = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
if (packageInfo.name !== '@kkelly-offical/kkcode' || packageInfo.version !== manifest.baseVersion) fail(`This display patch requires KK Code ${manifest.baseVersion}; upgrade the gateway base first`)
const src = join(target, 'src'), web = join(src, 'web')
for (const directory of [src, web]) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Web directories must be real directories, not symlinks')
}
async function tree(directory, prefix = '') {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) fail(`Unsupported Web entry: ${name}`)
    if (entry.isDirectory()) found.push(...await tree(join(directory, entry.name), `${name}/`))
    else found.push(name)
  }
  return found.sort()
}
async function matches(directory, row) {
  try { const data = await readFile(join(directory, row.path)); return data.length === row.size && hash(data) === row.sha256 }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function verify(directory, rows) {
  for (const row of rows.values()) if (!await matches(directory, row)) fail(`Checksum mismatch: ${row.path}`)
}
async function knownWeb() {
  for (const name of await tree(web)) {
    const choices = [baseFiles.get(name), files.get(name)].filter(Boolean)
    if (!(await Promise.all(choices.map(row => matches(web, row)))).some(Boolean)) fail(`Web contains a local change: ${name}; keep it and inspect before applying this patch`)
  }
}
async function atomicWrite(name, bytes) {
  const destination = join(web, name), parent = dirname(destination)
  const inside = relative(web, parent)
  if (inside.startsWith('..') || isAbsolute(inside)) fail('Escaped Web directory')
  // Current Vite assets use the existing assets directory. Do not follow a
  // replacement symlink or create arbitrary directories from a manifest.
  for (let directory = parent; directory !== src; directory = dirname(directory)) {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Unsafe Web asset directory')
  }
  const temporary = join(parent, `.kkcode-display-${randomUUID()}.tmp`)
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 }); await chmod(temporary, 0o644); await rename(temporary, destination) }
  finally { await rm(temporary, { force: true }) }
}
const lockPath = join(src, '.kkcode-web-display.lock'), token = randomUUID()
let lock
try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, token })) }
catch (error) { if (error.code === 'EEXIST') fail('Another display installer or interrupted lock exists; inspect it before retrying'); throw error }
try {
  await knownWeb()
  if (options.has('--rollback')) {
    const backup = await realpath(resolve(options.get('--rollback')))
    if (dirname(backup) !== src || !backup.startsWith(join(src, '.kkcode-web-backup-'))) fail('Backup must belong to this installed package')
    const receipt = JSON.parse(await readFile(join(backup, 'receipt.json'), 'utf8'))
    if (receipt.target !== target || receipt.displayVersion !== manifest.displayVersion) fail('Backup identity does not match this installation')
    await tree(join(backup, 'web')); await verify(join(backup, 'web'), baseFiles)
    for (const row of baseFiles.values()) if (row.path !== 'index.html') await atomicWrite(row.path, await readFile(join(backup, 'web', row.path)))
    await atomicWrite('index.html', await readFile(join(backup, 'web/index.html')))
    if (!baseFiles.has('display-patch.json') && files.has('display-patch.json') && await matches(web, files.get('display-patch.json'))) await rm(join(web, 'display-patch.json'))
    await verify(web, baseFiles)
    console.log(JSON.stringify({ restored: manifest.baseVersion, backup, retainedHashedAssets: true }))
  } else {
    const payload = join(bundle, 'src/web')
    const payloadNames = await tree(payload)
    if (payloadNames.length !== files.size || payloadNames.some(name => !files.has(name))) fail('Unexpected display payload file')
    await verify(payload, files)
    if ((await Promise.all([...files.values()].map(row => matches(web, row)))).every(Boolean)) {
      console.log(JSON.stringify({ alreadyInstalled: manifest.displayVersion }));
    } else {
      await verify(web, baseFiles)
      const backup = await mkdtemp(join(src, '.kkcode-web-backup-'))
      for (const row of baseFiles.values()) {
        const destination = join(backup, 'web', row.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, await readFile(join(web, row.path)), { flag: 'wx', mode: 0o600 })
      }
      await verify(join(backup, 'web'), baseFiles)
      await writeFile(join(backup, 'receipt.json'), JSON.stringify({ target, displayVersion: manifest.displayVersion, source: manifest.source, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ backup }))
      for (const row of files.values()) if (!['index.html', 'display-patch.json'].includes(row.path)) await atomicWrite(row.path, await readFile(join(payload, row.path)))
      // Old immutable assets remain available to open browser tabs. Index is
      // switched only after all new assets are present, with no directory gap.
      await verify(web, baseFiles)
      await atomicWrite('index.html', await readFile(join(payload, 'index.html')))
      if (files.has('display-patch.json')) await atomicWrite('display-patch.json', await readFile(join(payload, 'display-patch.json')))
      await verify(web, files)
      console.log(JSON.stringify({ installed: manifest.displayVersion, backup, restartRequired: false }))
    }
  }
} finally {
  await lock.close()
  if (JSON.parse(await readFile(lockPath, 'utf8')).token === token) await rm(lockPath)
}
