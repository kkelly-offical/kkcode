import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ProtocolError } from '../protocol/index.mjs'
import { resolveDevicePath } from './files.mjs'

const executeFile = promisify(execFile)
const mutations = new Map()
const noHooks = path.join(os.tmpdir(), `kkcode-disabled-hooks-${randomUUID()}`)
const baseConfig = ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false']
const gitEnv = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_|$))/.test(key)) delete env[key]
  return env
}
async function git(cwd, args, { acceptFailure = false, config = [] } = {}) {
  try { return (await executeFile('git', [...baseConfig, ...config, ...args], { cwd, env: gitEnv(), timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true })).stdout }
  catch (error) {
    if (acceptFailure && Number.isInteger(error.code)) return null
    throw new ProtocolError('git_failed', 'Git could not safely complete this operation; inspect the repository locally', 409)
  }
}
const gitPathLine = output => output.replace(/\r?\n$/, '')
/** Git for Windows prints forward slashes while Node returns native separators.
 * realpath also does not guarantee case normalization; aliases such as NTFS 8.3
 * paths must be compared by filesystem identity, not by lowercasing strings.
 */
export async function sameGitDirectory(output, expected, { pathApi = path, realpathImpl = realpath, statImpl = stat } = {}) {
  if (typeof output !== 'string' || !output) return false
  const reported = gitPathLine(output)
  if (!pathApi.isAbsolute(reported)) throw new ProtocolError('unsafe_git_path', 'Git returned a non-absolute repository path', 409)
  const [actual, wanted] = await Promise.all([realpathImpl(pathApi.resolve(reported)), realpathImpl(pathApi.resolve(expected))])
  const [left, right] = await Promise.all([statImpl(actual, { bigint: true }), statImpl(wanted, { bigint: true })])
  if (!left.isDirectory() || !right.isDirectory()) return false
  if (actual === wanted) return true
  // A filesystem without stable inode identifiers must fail closed for aliases.
  return left.ino > 0n && right.ino > 0n && left.ino === right.ino && left.dev === right.dev
}
export async function deviceRepository(cwd, roots) {
  const directory = await resolveDevicePath(cwd, roots, { directory: true })
  const top = await git(directory, ['rev-parse', '--show-toplevel'], { acceptFailure: true })
  if (!top) throw new ProtocolError('not_repository', 'Choose a Git working directory', 409)
  return resolveDevicePath(gitPathLine(top), roots, { directory: true })
}
function gitlinks(output) {
  return output.split('\0').filter(row => row.startsWith('160000 ')).map(row => {
    const [prefix, ...name] = row.split('\t')
    const fields = prefix.split(' ')
    return { path: name.join('\t'), commit: fields[1] === 'commit' ? fields[2] : fields[1] }
  }).sort((a, b) => a.path.localeCompare(b.path))
}
async function repositorySnapshot(cwd, depth = 0) {
  if (depth > 5) throw new ProtocolError('submodule_depth', 'Review deeply nested submodules locally before switching', 409)
  const config = await disabledFilters(cwd)
  const [head, current, status, refs, gitDir, index] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', 'HEAD'], { acceptFailure: true }),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { acceptFailure: true }),
    // Never let Git recurse into a child's independently configured filters.
    // Child status is inspected below with that child's filters disabled too.
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], { config }),
    git(cwd, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(worktreepath)%00', 'refs/heads/']),
    git(cwd, ['rev-parse', '--absolute-git-dir']),
    git(cwd, ['ls-files', '--stage', '-z'])
  ])
  const links = gitlinks(index), submodules = []
  if (links.length > 100) throw new ProtocolError('submodule_limit', 'Review large submodule sets locally before switching', 409)
  for (const link of links) {
    const child = path.join(cwd, link.path)
    let exists
    try { exists = await lstat(child) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!exists) { submodules.push({ ...link, initialized: false, clean: true }); continue }
    if (!exists.isDirectory() || exists.isSymbolicLink()) throw new ProtocolError('unsafe_submodule', 'Submodule paths must be regular directories', 409)
    const safeChild = await resolveDevicePath(child, [cwd], { directory: true })
    const childTop = await git(safeChild, ['rev-parse', '--show-toplevel'], { acceptFailure: true })
    if (!await sameGitDirectory(childTop, safeChild)) {
      const metadata = await lstat(path.join(safeChild, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (metadata) throw new ProtocolError('unsafe_submodule', 'Submodule Git metadata resolves to a different working directory; inspect it locally', 409)
      submodules.push({ ...link, initialized: false, clean: true }); continue
    }
    const state = await repositorySnapshot(safeChild, depth + 1)
    submodules.push({ ...link, initialized: true, clean: state.clean && state.head === link.commit, stateToken: state.stateToken })
  }
  const operationNames = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock', 'HEAD.lock']
  const operations = (await Promise.all(operationNames.map(async name => { try { await access(path.join(gitPathLine(gitDir), name)); return name } catch { return null } }))).filter(Boolean)
  const branch = current?.trimEnd() || null
  const branches = refs.split('\n').filter(Boolean).map(row => {
    const [name, commit, checkout] = row.split('\0')
    return { name, commit, current: name === branch, checkedOut: Boolean(checkout) }
  })
  const snapshot = { cwd, current: branch, head: head?.trimEnd() || null, clean: status.length === 0 && operations.length === 0 && submodules.every(module => module.clean), branches, operations, submodules }
  const stateToken = createHash('sha256').update(JSON.stringify({ ...snapshot, status })).digest('hex')
  return { ...snapshot, stateToken }
}
export async function listDeviceBranches(cwd, roots) {
  return repositorySnapshot(await deviceRepository(cwd, roots))
}
async function validateBranch(cwd, name) {
  if (typeof name !== 'string' || name.length > 240 || name.startsWith('-') || /[\x00-\x20\x7f]/.test(name) || name.startsWith('refs/') || name === 'HEAD' || name.includes('@{')) throw new ProtocolError('invalid_branch', 'Choose a valid local branch name')
  if (await git(cwd, ['check-ref-format', '--branch', name], { acceptFailure: true }) === null) throw new ProtocolError('invalid_branch', 'Choose a valid local branch name')
}
/** Git checkout filters can execute arbitrary commands even without a shell here.
 * Disable every configured filter driver in addition to hooks and fsmonitor.
 * Only plain local refs are accepted; no network, reset, clean, stash or force.
 */
async function disabledFilters(cwd) {
  const names = await git(cwd, ['config', '--name-only', '--get-regexp', '^filter\\.'], { acceptFailure: true })
  const drivers = new Set()
  for (const name of (names || '').split('\n').filter(Boolean)) {
    if (/[\x00-\x20\x7f]/.test(name)) throw new ProtocolError('unsafe_git_config', 'Review unusual Git filter configuration locally', 409)
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(name)
    if (match) drivers.add(match[1])
  }
  return [...drivers].flatMap(driver => ['-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`])
}
export async function changeDeviceBranch({ cwd, roots, name, confirmed, stateToken, create = false, assertIdle = async () => {} }) {
  if (confirmed !== true) throw new ProtocolError('confirmation_required', 'Confirm the branch change explicitly', 409)
  const repo = await deviceRepository(cwd, roots), previous = mutations.get(repo) || Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    await validateBranch(repo, name)
    await assertIdle(repo)
    const before = await repositorySnapshot(repo)
    if (typeof stateToken !== 'string' || stateToken !== before.stateToken) throw new ProtocolError('branch_state_changed', 'Repository changed; refresh the branch list and confirm again', 409)
    if (!before.clean) throw new ProtocolError('worktree_dirty', 'Commit or safely preserve all changes locally before switching branches', 409)
    if (!before.head) throw new ProtocolError('unborn_repository', 'Create the first commit locally before switching branches', 409)
    const target = before.branches.find(branch => branch.name === name)
    if (create && target) throw new ProtocolError('branch_exists', 'A branch with this name already exists', 409)
    if (!create && !target) throw new ProtocolError('branch_missing', 'Choose an existing local branch', 404)
    if (!create && target.current) return before
    if (target?.checkedOut) throw new ProtocolError('branch_in_use', 'This branch is checked out in another worktree', 409)
    if (!create) {
      const nextLinks = gitlinks(await git(repo, ['ls-tree', '-r', '-z', `refs/heads/${name}`]))
      const currentLinks = before.submodules.map(({ path, commit }) => ({ path, commit }))
      if (JSON.stringify(nextLinks) !== JSON.stringify(currentLinks)) throw new ProtocolError('submodule_change', 'This branch changes submodule revisions; switch and update them locally to preserve their state', 409)
    }
    const config = await disabledFilters(repo)
    // Recheck after configuration inspection; never rely on the UI's old view.
    await assertIdle(repo)
    if ((await repositorySnapshot(repo)).stateToken !== before.stateToken) throw new ProtocolError('branch_state_changed', 'Repository changed; refresh and confirm again', 409)
    await git(repo, create ? ['switch', '--no-guess', '--no-recurse-submodules', '-c', name] : ['switch', '--no-guess', '--no-recurse-submodules', '--', name], { config })
    // Resolve again to reject unexpected repository symlink changes.
    if (await realpath(repo) !== repo) throw new ProtocolError('path_denied', 'Repository path changed during the operation', 403)
    return repositorySnapshot(repo)
  })
  mutations.set(repo, operation)
  try { return await operation } finally { if (mutations.get(repo) === operation) mutations.delete(repo) }
}
