import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, realpath, readlink, symlink, rename, unlink } from 'node:fs/promises'
import { createTaskWorkspace } from './task-workspace.mjs'
import { copySealedRegularFile } from './verification-workspace.mjs'
import { captureAcceptanceCandidate } from '../session/acceptance-manifest.mjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'graph_workspace_changed' }) }
function target(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f\x7f]/.test(relative)
    || relative.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) fail('子任务快照包含不安全文件路径。')
  return path.join(root, relative)
}
function within(root, file) {
  const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** A child sees the sealed current candidate, not a stale HEAD-only checkout.
 * Every removed/replaced entry belongs to the newly materialized child. Parent
 * files, hooks, index and ignored dependency directories are never changed. */
export async function createGraphWorkspace({ cwd, candidateHash, baseRevision, parent, signal }) {
  const source = await realpath(cwd)
  const candidate = await captureAcceptanceCandidate(source, { includeFiles: true })
  if (candidate.treeFingerprint !== candidateHash || candidate.head !== baseRevision) fail('父候选在委派前变化，请重新核准任务图。')
  if (candidate.files.reduce((total, file) => total + (file.size || 0), 0) > 1024 * 1024 * 1024) fail('子任务快照超过 1 GiB。')
  signal?.throwIfAborted()
  const child = await createTaskWorkspace({ cwd: source, expectedCommit: baseRevision, ...(parent ? { parent } : {}) })
  const identity = await lstat(child.cwd)
  async function owned() {
    const current = await lstat(child.cwd)
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) fail('子任务工作树身份发生变化。')
  }
  try {
    const baseline = await captureAcceptanceCandidate(child.cwd, { includeFiles: true })
    // Remove exact baseline blobs first, so an old symlink can never become a
    // parent directory through which a new file is written.
    for (const file of baseline.files) {
      signal?.throwIfAborted(); await owned()
      const filePath = target(child.cwd, file.path), info = await lstat(filePath)
      if (!info.isFile() && !info.isSymbolicLink()) fail('新建子任务副本出现非普通文件。')
      await unlink(filePath)
    }
    const links = []
    for (const file of candidate.files) {
      signal?.throwIfAborted(); await owned()
      if (file.kind === 'missing') continue
      const sourceFile = target(source, file.path), destination = target(child.cwd, file.path)
      if (file.kind === 'symlink') {
        const link = await readlink(sourceFile)
        if (!link || path.isAbsolute(link) || link.includes('\\') || !within(source, path.resolve(path.dirname(sourceFile), link))
          || !within(child.cwd, path.resolve(path.dirname(destination), link))) fail('子任务快照符号链接越出工作区。')
        links.push({ destination, link }); continue
      }
      if (file.kind !== 'file') fail('子任务快照包含特殊对象。')
      const temporary = `${destination}.kkgraph-${randomUUID()}.tmp`
      try {
        await copySealedRegularFile(sourceFile, temporary, file, signal)
        await owned()
        await rename(temporary, destination)
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    }
    for (const { destination, link } of links) {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await symlink(link, destination)
      if (!within(child.cwd, await realpath(destination))) fail('子任务符号链接解析后越界。')
    }
    await owned()
    const [parentAfter, childAfter] = await Promise.all([captureAcceptanceCandidate(source), captureAcceptanceCandidate(child.cwd)])
    if (parentAfter.treeFingerprint !== candidateHash || childAfter.treeFingerprint !== candidateHash) fail('复制期间候选内容变化，未启动子任务。')
    return { ...child, candidateHash }
  } catch (error) {
    // Preserve the exact private worktree for inspection; never create a second
    // workspace on recovery just because this operation's reply was lost.
    error.workspace = child.cwd
    throw error
  }
}
