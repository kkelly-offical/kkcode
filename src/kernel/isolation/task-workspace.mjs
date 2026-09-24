import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, symlink, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { userRootDir } from '../../storage/paths.mjs'

const exec = promisify(execFile)
const invalid = message => { throw Object.assign(new Error(message), { code: 'task_workspace_invalid' }) }
const gitEnv = () => ({ ...Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP'].filter(key => process.env[key]).map(key => [key, process.env[key]])), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' })
async function git(cwd, args, maxBuffer = 16 * 1024 * 1024) {
  return (await exec('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false', ...args], { cwd, env: gitEnv(), encoding: 'buffer', timeout: 30000, maxBuffer, windowsHide: true })).stdout
}
export async function taskWorkspaceBaseline(cwd) {
  const root = await realpath(cwd)
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).toString().trim()
  if (await realpath(top) !== root) invalid('请在Git仓库根目录创建委托任务。')
  const commit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) invalid('无法固定任务的Git基线。')
  return { cwd: root, commit }
}

/** Materialize raw blobs, never checkout/smudge/filter repository-controlled code.
 * The original index and dirty tree are untouched. Failure preserves the partial
 * private workspace for inspection, never recursively removes another worktree.
 * @param {{cwd?: string, expectedCommit?: string, parent?: string, maxFiles?: number, maxBytes?: number}} [options]
 */
export async function createTaskWorkspace({ cwd, expectedCommit, parent = path.join(userRootDir(), 'worktrees'), maxFiles = 100000, maxBytes = 1024 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) invalid('任务物化资源上限无效。')
  const baseline = await taskWorkspaceBaseline(cwd)
  if (baseline.commit !== expectedCommit) invalid('确认后仓库HEAD发生变化，请重新确认任务基线。')
  const entries = (await git(baseline.cwd, ['ls-tree', '-r', '-z', '--full-tree', expectedCommit])).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(line)
    if (!match) invalid('Git树包含无法识别的条目。')
    const [, mode, type, oid, name] = match
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) invalid('严格任务暂不自动物化子模块或特殊Git对象。')
    if (name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || path.isAbsolute(name) || name.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) invalid('Git树包含不安全的工作目录路径。')
    return { mode, oid, name, size: 0 }
  })
  if (entries.length > maxFiles) invalid('任务文件数超过安全物化上限。')
  let total = 0
  // Validate sizes before creating a worktree; raw cat-file never runs filters.
  for (const entry of entries) {
    entry.size = Number((await git(baseline.cwd, ['cat-file', '-s', entry.oid])).toString().trim())
    total += entry.size
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 128 * 1024 * 1024 || total > maxBytes) invalid('任务快照超过文件或总容量上限。')
  }
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await lstat(parent)).isSymbolicLink()) invalid('任务工作区父目录不能是符号链接。')
  const parentRoot = await realpath(parent), workspace = await mkdtemp(path.join(parentRoot, 'run-'))
  try {
    await git(baseline.cwd, ['worktree', 'add', '--detach', '--no-checkout', '--', workspace, expectedCommit])
    for (const entry of entries) {
      const target = path.join(workspace, entry.name), bytes = await git(baseline.cwd, ['cat-file', 'blob', entry.oid], entry.size + 1024)
      if (bytes.length !== entry.size) invalid('物化过程中Git对象大小发生变化。')
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      if (entry.mode === '120000') {
        const link = bytes.toString('utf8'), resolved = path.resolve(path.dirname(target), link), relative = path.relative(workspace, resolved)
        if (!link || link.includes('\0') || link.includes('\\') || path.isAbsolute(link) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid('任务快照中的符号链接指向工作区外，未启动执行。')
        await symlink(link, target)
      } else await writeFile(target, bytes, { mode: entry.mode === '100755' ? 0o700 : 0o600, flag: 'wx' })
    }
    await git(workspace, ['read-tree', expectedCommit])
    return { cwd: workspace, sourceCwd: baseline.cwd, baseRevision: expectedCommit, originalWorkingTreeUnchanged: true }
  } catch (error) {
    throw Object.assign(new Error(`任务工作区准备失败，未启动模型。已保留目录以便检查：${workspace}。${error.code === 'task_workspace_invalid' ? error.message : '请检查Git对象、磁盘及路径权限。'}`), { code: 'task_workspace_prepare_failed', workspace })
  }
}
