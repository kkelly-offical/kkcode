import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ProtocolError } from '../protocol/index.mjs'
import { resolveDevicePath, resolveNewDevicePath } from './files.mjs'

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
async function worktreeListing(cwd) {
  // -z was added after Git 2.34 (still common on LTS hosts). Legacy porcelain
  // remains usable for ordinary paths; quoted/control-character paths fail
  // closed below instead of guessing how C-style octal escapes should decode.
  const zero = await git(cwd, ['worktree', 'list', '--porcelain', '-z'], { acceptFailure: true })
  return zero === null ? git(cwd, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']) : zero
}
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
  const [head, current, status, refs, gitDir, index, worktreeState] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', 'HEAD'], { acceptFailure: true }),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { acceptFailure: true }),
    // Never let Git recurse into a child's independently configured filters.
    // Child status is inspected below with that child's filters disabled too.
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], { config }),
    git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(worktreepath)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso8601-strict)%00%(subject)%00', 'refs/heads/', 'refs/remotes/']),
    git(cwd, ['rev-parse', '--absolute-git-dir']),
    git(cwd, ['ls-files', '--stage', '-z']),
    worktreeListing(cwd)
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
    submodules.push({ ...link, initialized: true, clean: state.clean && state.head === link.commit, stateToken: state.stateToken, submodules: state.submodules })
  }
  const operationNames = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock', 'HEAD.lock']
  const operations = (await Promise.all(operationNames.map(async name => { try { await access(path.join(gitPathLine(gitDir), name)); return name } catch { return null } }))).filter(Boolean)
  const branch = current?.trimEnd() || null
  const allRefs = refs.split('\n').filter(Boolean).map(row => {
    const [ref, commit, checkout, upstream, tracking, lastCommitAt, subject] = row.split('\0')
    const remote = ref.startsWith('refs/remotes/'), name = ref.replace(/^refs\/(heads|remotes)\//, '')
    return { name, ref, commit, remote, current: !remote && name === branch, checkedOut: Boolean(checkout), upstream: upstream || null, tracking: tracking || '', ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] || 0), behind: Number(/behind (\d+)/.exec(tracking)?.[1] || 0), lastCommitAt, subject: String(subject || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) }
  })
  const branches = allRefs.filter(ref => !ref.remote), remoteBranches = allRefs.filter(ref => ref.remote && !ref.name.endsWith('/HEAD'))
  const snapshot = { cwd, current: branch, head: head?.trimEnd() || null, clean: status.length === 0 && operations.length === 0 && submodules.every(module => module.clean), branches, remoteBranches, operations, submodules }
  const stateToken = createHash('sha256').update(JSON.stringify({ ...snapshot, status, worktreeState })).digest('hex')
  return { ...snapshot, stateToken }
}
export async function listDeviceBranches(cwd, roots) {
  const repo = await deviceRepository(cwd, roots), snapshot = await repositorySnapshot(repo)
  const records = parseWorktrees(await worktreeListing(repo))
  const worktrees = []; let unavailableWorktrees = 0
  for (const record of records.slice(0, 64)) {
    try {
      if (record.bare) continue
      if (typeof record.path !== 'string' || record.path.startsWith('"') || /[\x00-\x1f\x7f]/.test(record.path)) { unavailableWorktrees++; continue }
      const folder = await resolveDevicePath(record.path, roots, { directory: true })
      const top = await git(folder, ['rev-parse', '--show-toplevel'], { acceptFailure: true })
      if (!await sameGitDirectory(top, folder)) { unavailableWorktrees++; continue }
      worktrees.push({ path: folder, branch: record.branch?.replace(/^refs\/heads\//, '') || null, head: record.HEAD || null, locked: Boolean(record.locked), prunable: Boolean(record.prunable), current: await sameGitDirectory(`${folder}\n`, repo) })
    } catch { unavailableWorktrees++ }
  }
  const suggestedParent = await resolveDevicePath(path.dirname(repo), roots, { directory: true }).catch(() => repo)
  return { ...snapshot, worktrees, unavailableWorktrees: unavailableWorktrees + Math.max(0, records.length - 64), suggestedParent }
}
function parseWorktrees(raw) {
  const result = []; let current = null
  for (const field of raw.includes('\0') ? raw.split('\0') : raw.split(/\r?\n/)) {
    if (!field) { if (current) result.push(current); current = null; continue }
    const space = field.indexOf(' '), key = space < 0 ? field : field.slice(0, space), value = space < 0 ? true : field.slice(space + 1)
    if (key === 'worktree') current = { path: value }
    else if (current && ['HEAD', 'branch', 'bare', 'detached', 'locked', 'prunable'].includes(key)) current[key] = value
  }
  if (current) result.push(current)
  return result
}
function startCommit(snapshot, startPoint) {
  if (!startPoint || startPoint === 'HEAD') return snapshot.head
  const found = [...snapshot.branches, ...snapshot.remoteBranches].find(ref => ref.name === startPoint || ref.ref === startPoint)
  if (!found || !/^[0-9a-f]{40,64}$/i.test(found.commit)) throw new ProtocolError('invalid_start_point', 'Choose a listed local or cached remote branch', 409)
  return found.commit
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
async function checkoutFilters(cwd, snapshot) {
  const config = await disabledFilters(cwd)
  for (const module of snapshot.submodules || []) if (module.initialized) config.push(...await checkoutFilters(path.join(cwd, module.path), module))
  return config
}
export async function changeDeviceBranch({ cwd, roots, name, confirmed, stateToken, create = false, startPoint = null, assertIdle = async () => {} }) {
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
    if (!create && target.current) return listDeviceBranches(repo, roots)
    if (target?.checkedOut) throw new ProtocolError('branch_in_use', 'This branch is checked out in another worktree', 409)
    const base = create ? startCommit(before, startPoint) : target.commit
    if (!create || startPoint) {
      const nextLinks = gitlinks(await git(repo, ['ls-tree', '-r', '-z', base]))
      const currentLinks = before.submodules.map(({ path, commit }) => ({ path, commit }))
      if (JSON.stringify(nextLinks) !== JSON.stringify(currentLinks)) throw new ProtocolError('submodule_change', 'This branch changes submodule revisions; switch and update them locally to preserve their state', 409)
    }
    // Git may inspect child status even with --no-recurse-submodules; propagate
    // disabled child filter drivers into every Git subprocess as well.
    const config = await checkoutFilters(repo, before)
    // Recheck after configuration inspection; never rely on the UI's old view.
    await assertIdle(repo)
    if ((await repositorySnapshot(repo)).stateToken !== before.stateToken) throw new ProtocolError('branch_state_changed', 'Repository changed; refresh and confirm again', 409)
    await git(repo, create ? ['switch', '--no-guess', '--no-recurse-submodules', '-c', name, ...(base === before.head ? [] : [base])] : ['switch', '--no-guess', '--no-recurse-submodules', '--', name], { config })
    // Resolve again to reject unexpected repository symlink changes.
    if (await realpath(repo) !== repo) throw new ProtocolError('path_denied', 'Repository path changed during the operation', 403)
    return listDeviceBranches(repo, roots)
  })
  mutations.set(repo, operation)
  try { return await operation } finally { if (mutations.get(repo) === operation) mutations.delete(repo) }
}

export async function createDeviceWorktree({ cwd, roots, name, folderName, parent, startPoint = null, confirmed, stateToken, assertIdle = async () => {} }) {
  if (confirmed !== true) throw new ProtocolError('confirmation_required', 'Confirm creating a new Git worktree', 409)
  const repo = await deviceRepository(cwd, roots), previous = mutations.get(repo) || Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    await assertIdle(); await validateBranch(repo, name)
    if (typeof folderName !== 'string' || !folderName || folderName.length > 120 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(folderName) || /[. ]$/.test(folderName) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(folderName)) throw new ProtocolError('invalid_folder_name', 'Choose a plain, cross-platform folder name')
    const directory = await resolveDevicePath(parent, roots, { directory: true })
    const destination = await resolveNewDevicePath(path.join(directory, folderName), roots)
    const before = await repositorySnapshot(repo)
    if (stateToken !== before.stateToken) throw new ProtocolError('branch_state_changed', 'Repository changed; refresh and confirm again', 409)
    if (before.operations.length || !before.head) throw new ProtocolError('repository_busy', 'Finish the current Git operation or initial commit first', 409)
    if (before.branches.some(branch => branch.name === name)) throw new ProtocolError('branch_exists', 'Use a new branch name; existing branches are never reset', 409)
    const base = startCommit(before, startPoint), config = await checkoutFilters(repo, before)
    await assertIdle()
    if ((await repositorySnapshot(repo)).stateToken !== before.stateToken) throw new ProtocolError('branch_state_changed', 'Repository changed; refresh and confirm again', 409)
    await mkdir(destination, { mode: 0o700 })
    const pinned = await lstat(destination)
    await git(repo, ['worktree', 'add', '--no-track', '-b', name, '--', destination, base], { config })
    const current = await lstat(destination)
    if (current.isSymbolicLink() || current.ino !== pinned.ino || current.dev !== pinned.dev || await realpath(directory) !== directory) throw new ProtocolError('path_changed', 'Worktree location changed; inspect the operation locally', 409)
    await resolveDevicePath(destination, roots, { directory: true })
    return { ...await listDeviceBranches(repo, roots), created: { path: destination, branch: name, head: base }, sourceFilesChanged: false }
  })
  mutations.set(repo, operation)
  try { return await operation } finally { if (mutations.get(repo) === operation) mutations.delete(repo) }
}
