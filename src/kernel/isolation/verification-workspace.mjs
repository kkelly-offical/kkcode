import path from "node:path"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, lstat, realpath, readlink, symlink, open, rm } from "node:fs/promises"
import { userRootDir } from "../../storage/paths.mjs"
import { captureAcceptanceCandidate, captureAcceptanceSources, fingerprintAcceptanceFile } from "../session/acceptance-manifest.mjs"

const fail = message => { throw Object.assign(new Error(message), { code: "verification_workspace_invalid" }) }
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const within = (root, target) => { const relative = path.relative(root, target); return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
const sameFile = (a, b) => a.path === b.path && a.kind === b.kind && a.hash === b.hash && a.size === b.size && a.executable === b.executable
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

function safePath(root, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || /[\x00-\x1f\x7f]/.test(name)
    || path.isAbsolute(name) || name.split("/").some(part => ["", ".", "..", ".git"].includes(part.toLowerCase()))) fail("验收候选包含不安全路径")
  const target = path.join(root, name)
  if (!within(root, target)) fail("验收文件越出候选工作区")
  return target
}

async function copyRegular(source, target, expected, signal) {
  const before = await lstat(source)
  if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024 * 1024) fail("验收不复制硬链接、特殊文件或超大文件")
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  let output
  try {
    const info = await input.stat()
    if (info.ino !== before.ino || info.dev !== before.dev || info.nlink !== 1 || info.size !== before.size) fail("验收源文件在打开时发生变化")
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    output = await open(target, "wx", expected.executable ? 0o700 : 0o600)
    const digest = createHash("sha256")
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      digest.update(chunk)
      await output.writeFile(chunk)
    }
    const after = await input.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || digest.digest("hex") !== expected.hash) {
      fail("验收源文件复制期间发生变化")
    }
    await output.sync()
  } finally { await output?.close(); await input.close() }
}

// Host-only reuse for newly materialized private workspaces. The caller must
// validate source/target containment and owns the destination parent directory.
// Destination is exclusive (wx), never an implicit overwrite of an existing file.
export { copyRegular as copySealedRegularFile }

async function validateSnapshot(snapshot) {
  const identity = await lstat(snapshot.cwd)
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino !== snapshot.identity.ino || identity.dev !== snapshot.identity.dev) fail("验收副本身份发生变化")
  for (const expected of snapshot.files) {
    const target = safePath(snapshot.cwd, expected.path)
    if (expected.kind === "missing") {
      const exists = await lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error })
      if (exists) fail("已删除的候选源文件在验收过程中被重新创建")
      continue
    }
    const info = await lstat(target)
    if (info.isFile() && info.nlink !== 1) fail("验收副本源文件被替换为硬链接")
    const observed = await fingerprintAcceptanceFile(snapshot.cwd, expected.path)
    if (!sameFile(expected, observed)) fail(`验收命令修改了已封存源文件：${expected.path}`)
  }
}

async function removeSnapshot(snapshot) {
  const info = await lstat(snapshot.cwd).catch(error => { if (error.code === "ENOENT") return null; throw error })
  if (!info) return
  if (info.ino !== snapshot.identity.ino || info.dev !== snapshot.identity.dev || info.isSymbolicLink() || !info.isDirectory()) fail("验收副本身份改变，拒绝自动清理")
  // Only the exact mkdtemp directory whose identity is still ours is removed.
  await rm(snapshot.cwd, { recursive: true, force: false })
}

/** Independent private verification copy. No checkout/filter/hook executes, no
 * .git or ignored dependency directory is shared with the implementation tree.
 * Existing candidate sources are read-only mounts; only new output paths can be
 * created. One copy per manifest preserves build -> test output, never across
 * candidates. createBackend must preserve the host-approved immutable image.
 * @param {{cwd: string, createBackend: Function, signal?: AbortSignal|null,
 * parent?: string, maxBytes?: number, maxFiles?: number}} options
 */
export function createVerificationRunner({ cwd, createBackend, signal = null,
  parent = path.join(userRootDir(), "verification-workspaces"), maxBytes = 1024 * 1024 * 1024, maxFiles = 100000 }) {
  if (typeof createBackend !== "function") fail("缺少独立验收隔离后端，拒绝复用实现进程")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024 || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100000) fail("验收副本容量限制无效")
  let active = null, closed = false, chain = Promise.resolve()

  async function assertOriginal(metadata) {
    const source = await realpath(cwd)
    const candidate = await captureAcceptanceCandidate(source, { includeFiles: true })
    if (candidate.treeFingerprint !== metadata.candidateHash) fail("原候选已改变，旧验收回执不能复用")
    const originalSources = await captureAcceptanceSources({ cwd: source, paths: metadata.testSources.map(file => file.path) })
    if (originalSources.fingerprint !== metadata.sourceFingerprint) fail("原始验收来源指纹不匹配")
    for (const expected of metadata.testSources) {
      const observed = await fingerprintAcceptanceFile(source, expected.path)
      if (!sameFile(expected, observed)) fail("原始验收来源发生变化，拒绝运行")
    }
    return { source, candidate }
  }

  async function prepare(metadata) {
    const { source, candidate } = await assertOriginal(metadata)
    if (candidate.files.length > maxFiles || candidate.files.reduce((sum, file) => sum + (file.size || 0), 0) > maxBytes) fail("验收候选超过副本容量限制")
    if (candidate.files.some(file => file.size > 128 * 1024 * 1024)) fail("验收候选单个文件超过 128 MiB")
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if ((await lstat(parent)).isSymbolicLink()) fail("验收副本父目录不能是符号链接")
    const snapshotCwd = await mkdtemp(path.join(await realpath(parent), "candidate-"))
    const snapshot = { cwd: snapshotCwd, identity: await lstat(snapshotCwd), files: candidate.files, metadata: structuredClone(metadata), backend: null }
    try {
      const links = []
      for (const file of candidate.files) {
        signal?.throwIfAborted()
        const target = safePath(snapshotCwd, file.path), original = safePath(source, file.path)
        if (file.kind === "missing") continue
        if (file.kind === "symlink") {
          const link = await readlink(original)
          if (!link || path.isAbsolute(link) || link.includes("\\") || !within(source, path.resolve(path.dirname(original), link))
            || !within(snapshotCwd, path.resolve(path.dirname(target), link))) fail("验收候选符号链接越出工作区")
          links.push({ file, link, target })
        } else if (file.kind === "file") await copyRegular(original, target, file, signal)
        else fail("验收候选包含不支持的特殊对象")
      }
      for (const { link, target } of links) {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await symlink(link, target)
        const destination = await realpath(target)
        if (!within(snapshotCwd, destination)) fail("验收候选符号链接解析后越界")
      }
      // Sources excluded by .gitignore are still original acceptance evidence.
      // Do not silently copy an unsealed ignored dependency or test fixture.
      for (const sourceFile of metadata.testSources) {
        if (!candidate.files.some(file => sameFile(sourceFile, file))) fail("原始验收来源不在已封存候选内")
      }
      await validateSnapshot(snapshot)
      await assertOriginal(metadata)
      const readOnlyPaths = candidate.files.filter(file => file.kind !== "missing").map(file => file.path)
      snapshot.backend = await createBackend({ readOnlyPaths })
      if (!snapshot.backend?.ensureReady || !snapshot.backend?.runCommand) fail("独立验收后端不完整")
      const report = await snapshot.backend.ensureReady({ cwd: snapshotCwd, contract: { allowedPaths: ["."] }, signal })
      if (report?.strict !== true || report?.network !== "none") fail("独立验收后端没有提供严格隔离与禁止出网证明")
      return snapshot
    } catch (error) {
      await snapshot.backend?.dispose?.().catch(() => {})
      await removeSnapshot(snapshot)
      throw error
    }
  }

  return {
    runCommand(request) {
      const work = chain.then(async () => {
        signal?.throwIfAborted()
        if (closed) fail("验收工作区已关闭")
        if (request.shell !== false || await realpath(request.cwd) !== await realpath(cwd)) fail("验收命令不属于当前工作区或请求了 Shell")
        const metadata = request.acceptance
        if (!metadata || !validHash(metadata.manifestId) || !validHash(metadata.candidateHash) || !validHash(metadata.boundaryId) || !validHash(metadata.sourceFingerprint)
          || !Array.isArray(metadata.testSources) || !metadata.testSources.length || metadata.testSources.some(file => file.kind !== "file" || !validHash(file.hash))) fail("验收命令缺少宿主封存候选和原始来源")
        if (!active || active.metadata.manifestId !== metadata.manifestId) {
          if (active) { await active.backend?.dispose?.(); await removeSnapshot(active); active = null }
          active = await prepare(metadata)
        } else if (hash(active.metadata) !== hash(metadata)) fail("相同验收清单的绑定内容发生变化")
        await assertOriginal(metadata)
        await validateSnapshot(active)
        let outcome, failure
        try { outcome = await active.backend.runCommand({ ...request, cwd: active.cwd, shell: false }) }
        catch (error) { failure = error }
        // Recheck even after timeout/error; never accept an exit code alone.
        await validateSnapshot(active)
        await assertOriginal(metadata)
        if (failure) throw failure
        const code = outcome?.code ?? outcome?.exitCode ?? null
        return { ...outcome, code, ok: code === 0 && !outcome?.timedOut && !outcome?.cancelled && !outcome?.overflow }
      })
      chain = work.catch(() => {})
      return work
    },
    async dispose() {
      closed = true
      await chain
      if (active) { await active.backend?.dispose?.(); await removeSnapshot(active); active = null }
    }
  }
}
