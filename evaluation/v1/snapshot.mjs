import path from 'node:path'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, realpath, lstat, readlink, readdir, open, writeFile, symlink, chmod, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { captureAcceptanceCandidate } from '../../src/kernel/session/acceptance-manifest.mjs'
import { copySealedRegularFile } from '../../src/kernel/isolation/verification-workspace.mjs'
import { runControlledGit } from '../../src/util/controlled-git.mjs'
import { userRootDir } from '../../src/storage/paths.mjs'
import { sha256 } from './manifest.mjs'

const execute = promisify(execFile)
const fail = message => { throw new Error(`Evaluation snapshot: ${message}`) }
const within = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
const forbidden = name => name.split('/').some(part => ['.git', 'node_modules', 'test-results', '.kkcode', '.ssh', '.aws', '.gnupg', '.secrets', 'secrets'].includes(part))
  || /(?:^|\/)(?:\.npmrc|\.netrc|\.env(?:\.(?!example$|sample$|template$)[^/]+)?)$/.test(name)
  || /\.(?:jks|keystore|p12|pfx|key)$/i.test(name)
function target(root, name) {
  if (!name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || path.isAbsolute(name)
    || name.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe source path')
  const result = path.join(root, name)
  if (!within(root, result)) fail('source path escaped its root')
  return result
}
async function git(cwd, args) {
  const result = await runControlledGit(args, { cwd })
  if (!result.ok) fail('controlled Git inspection failed')
  return result.stdout
}
async function initialize(cwd, sourceRoot) {
  const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]))
  const disabled = process.platform === 'win32' ? 'NUL' : '/dev/null'
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: disabled, GIT_CONFIG_GLOBAL: disabled, GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' })
  let binary
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue
    try {
      const candidate = await realpath(path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git'))
      if (within(cwd, candidate) || within(sourceRoot, candidate)) continue
      await access(candidate, constants.X_OK)
      if ((await lstat(candidate)).isFile()) { binary = candidate; break }
    } catch { /* Ignore unavailable host executables, never search the repo. */ }
  }
  if (!binary) fail('a trusted host Git executable is required')
  // A new evaluator-owned repository has no local config, active hooks or
  // executable filter drivers. Never run an existing workspace's scripts.
  for (const args of [['init', '-q'], ['add', '--all'], ['-c', 'user.name=KK Code Evaluation', '-c', 'user.email=24042203053@ecupl.edu.cn', 'commit', '-qm', 'Frozen host evaluation source']]) {
    await execute(binary, ['-c', `core.hooksPath=${disabled}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], { cwd, env, timeout: 30000 })
  }
}

async function copyDependencies(source, destination, sourceRoot, targetRoot) {
  const manifest = [], links = [], maximumBytes = 4 * 1024 * 1024 * 1024
  let bytes = 0, copiedBytes = 0, files = 0
  const inodeCounts = new Map()
  let inventoried = 0
  async function inventory(directory) {
    for (const name of await readdir(directory)) {
      const entry = path.join(directory, name), info = await lstat(entry)
      if (++inventoried > 200000) fail('installed dependency inventory exceeds its limit')
      if (info.isDirectory()) await inventory(entry)
      else if (info.isFile()) {
        const key = `${info.dev}:${info.ino}`
        inodeCounts.set(key, (inodeCounts.get(key) || 0) + 1)
      }
    }
  }
  await inventory(source)
  async function visit(relative) {
    const from = path.join(source, relative), to = path.join(destination, relative), info = await lstat(from)
    if (info.isDirectory()) {
      await mkdir(to, { mode: 0o700 })
      for (const name of (await readdir(from)).sort()) await visit(path.join(relative, name))
      return
    }
    if (++files > 200000) fail('installed dependency copy exceeds file limit')
    if (info.isSymbolicLink()) {
      const originalLink = await readlink(from), resolved = path.resolve(path.dirname(from), originalLink)
      if (!within(sourceRoot, resolved)) fail('installed dependency symlink points outside the source repository')
      const mapped = path.join(targetRoot, path.relative(sourceRoot, resolved)), link = path.relative(path.dirname(to), mapped)
      if (!within(targetRoot, path.resolve(path.dirname(to), link))) fail('installed dependency symlink escaped the snapshot')
      links.push({ to, link }); manifest.push({ path: relative.split(path.sep).join('/'), kind: 'symlink', target: link }); return
    }
    // npm/esbuild legitimately shares a binary between two package paths.
    // Allow that only when every source link is accounted for inside this
    // dependency tree, then copy bytes into distinct private output inodes.
    if (!info.isFile() || inodeCounts.get(`${info.dev}:${info.ino}`) !== info.nlink || info.size > 128 * 1024 * 1024
      || (bytes += info.size) > maximumBytes) fail('installed dependency contains a special, unaccounted hardlink or oversized file')
    const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    let output
    try {
      const before = await input.stat(), digest = createHash('sha256')
      if (!before.isFile() || before.nlink !== info.nlink || before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) fail('dependency changed before copying')
      output = await open(to, 'wx', info.mode & 0o111 ? 0o500 : 0o400)
      let fileBytes = 0
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        fileBytes += chunk.length; copiedBytes += chunk.length
        if (fileBytes > before.size || fileBytes > 128 * 1024 * 1024 || copiedBytes > maximumBytes) fail('dependency grew beyond its sealed copy allowance')
        digest.update(chunk); await output.writeFile(chunk)
      }
      const after = await input.stat()
      if (fileBytes !== before.size || before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('dependency changed while copying')
      await output.sync()
      manifest.push({ path: relative.split(path.sep).join('/'), kind: 'file', size: before.size, executable: Boolean(info.mode & 0o111), hash: digest.digest('hex') })
    } finally { await output?.close(); await input.close() }
  }
  await visit('')
  for (const { to, link } of links) {
    await symlink(link, to)
    if (!within(targetRoot, await realpath(to))) fail('dependency symlink resolved outside the frozen host snapshot')
  }
  return { treeHash: sha256(manifest), files, bytes, manifest }
}

/** Private host-runtime snapshot, not a model task workspace. Oracles remain in
 * this trusted host copy; prepareTask still copies only each case's fixtures. */
export async function freezeEvaluationRuntime({ source = process.cwd(), parent = path.join(userRootDir(), 'evaluation-candidates'), baseRevision = 'HEAD', includeDependencies = true } = {}) {
  source = await realpath(source)
  if (within(source, path.resolve(parent))) fail('private snapshot must be outside the mutable source repository')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await lstat(parent)).isSymbolicLink()) fail('private snapshot parent cannot be a symlink')
  parent = await realpath(parent)
  if (within(source, parent)) fail('private snapshot must be outside the mutable source repository')
  const original = await captureAcceptanceCandidate(source, { includeFiles: true })
  const base = (await git(source, ['rev-parse', '--verify', '--end-of-options', `${baseRevision}^{commit}`])).trim()
  // Apply the same private-path exclusions to historical/deleted blobs, not
  // just to current file copies. Literal pathspecs cannot expand to secrets.
  const changed = (await git(source, ['diff', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean)
  const diffPaths = changed.filter(name => !forbidden(name))
  for (const name of diffPaths) target(source, name)
  const diff = diffPaths.length ? await git(source, ['diff', '--binary', base, '--', ...diffPaths.map(name => `:(literal)${name}`)]) : ''
  const root = await mkdtemp(path.join(parent, 'runtime-')), cwd = path.join(root, 'source')
  await mkdir(cwd, { mode: 0o700 })
  const copied = [], omitted = changed.filter(forbidden)
  try {
    for (const file of original.files) {
      if (file.kind === 'missing' || forbidden(file.path)) { if (!omitted.includes(file.path)) omitted.push(file.path); continue }
      // Reject source symlinks rather than accidentally importing host files.
      if (file.kind !== 'file') fail('source snapshot accepts regular Git-listed files only')
      await copySealedRegularFile(target(source, file.path), target(cwd, file.path), file)
      copied.push(file)
    }
    const after = await captureAcceptanceCandidate(source)
    if (after.head !== original.head || after.treeFingerprint !== original.treeFingerprint) fail('source changed during snapshot capture; retry after the current edits finish')
    await initialize(cwd, source)
    const candidate = await captureAcceptanceCandidate(cwd)
    const dependencies = includeDependencies ? await copyDependencies(path.join(source, 'node_modules'), path.join(cwd, 'node_modules'), source, cwd) : null
    if ((await captureAcceptanceCandidate(cwd)).treeFingerprint !== candidate.treeFingerprint) fail('installed dependencies must remain excluded by the copied .gitignore')
    const receipt = { schema: 'kk.evaluation.runtime-snapshot.v1', createdAt: new Date().toISOString(), sourceBaseRevision: base, sourceRevision: original.head,
      sourceCandidateHash: original.treeFingerprint, sourceDiffHash: sha256(diff), sourceDiffFiltered: true, sourceDiffPathsHash: sha256(diffPaths), sourceFilesHash: sha256(copied), omitted,
      candidateHash: candidate.treeFingerprint, candidateRevision: candidate.head, nodeVersion: process.version,
      dependencies: dependencies ? { treeHash: dependencies.treeHash, files: dependencies.files, bytes: dependencies.bytes } : null }
    await writeFile(path.join(root, 'source.diff'), diff, { flag: 'wx', mode: 0o600 })
    await writeFile(path.join(root, 'source-files.json'), JSON.stringify(copied, null, 2), { flag: 'wx', mode: 0o600 })
    if (dependencies) await writeFile(path.join(root, 'dependency-files.json'), JSON.stringify(dependencies.manifest, null, 2), { flag: 'wx', mode: 0o600 })
    await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 })
    // No model gets this host tree as its workspace; additionally remove
    // ordinary write bits from the copied source files and installed modules.
    for (const file of copied) await chmod(target(cwd, file.path), file.executable ? 0o500 : 0o400)
    return { root, cwd, ...receipt }
  } catch (error) { error.snapshotDirectory = root; throw error }
}
