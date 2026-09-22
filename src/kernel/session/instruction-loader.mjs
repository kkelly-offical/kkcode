import { runtimeCwd } from "../core/runtime-context.mjs"
import path from "node:path"
import { access, open, realpath } from "node:fs/promises"
import { constants } from 'node:fs'

const CANDIDATES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "KKCODE.md", ".kkcode.md", "kkcode.md"]

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function loadInstructions(cwd = runtimeCwd(), { stopAt = null } = {}) {
  const current = await realpath(cwd)
  const ceiling = stopAt ? await realpath(stopAt) : path.parse(current).root
  const scope = path.relative(ceiling, current)
  if (scope === '..' || scope.startsWith(`..${path.sep}`) || path.isAbsolute(scope)) throw new Error('Instruction search ceiling does not contain cwd')
  const ancestry = [current]
  let root = current, foundGit = false
  for (let dir = current; ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, '.git'))) { root = dir; foundGit = true; break }
    if (dir === ceiling || path.dirname(dir) === dir) break
    if (ancestry.length > 128) throw new Error('Instruction directory nesting exceeds 128 levels')
    ancestry.push(path.dirname(dir))
  }
  // Outside a Git repository, preserve cwd-only behavior rather than loading
  // unrelated parent/home instructions. A worktree .git file is also a boundary.
  const directories = foundGit ? ancestry.slice(0, ancestry.indexOf(root) + 1).reverse() : [current]
  const blocks = []
  const seen = new Set()
  let totalBytes = 0
  for (const directory of directories) for (const file of CANDIDATES) {
    const target = path.join(directory, file)
    if (!(await exists(target))) continue
    const resolved = await realpath(target)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    const relative = path.relative(root, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Instruction file escapes the project boundary: ${target}`)
    }
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0))
    let content
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Instruction source is not a regular file: ${target}`)
      const buffer = Buffer.alloc(128 * 1024 + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      totalBytes += size
      if (size > 128 * 1024 || totalBytes > 512 * 1024) throw new Error(`Instruction files exceed the 128 KiB/file or 512 KiB/project limit: ${target}`)
      content = buffer.subarray(0, size).toString('utf8').trim()
    } finally { await handle.close() }
    if (!content) continue
    blocks.push(`Instructions from ${target}\nScope: ${directory} and its descendants. Deeper directory instructions take precedence within their scope.\n${content}`)
  }
  return blocks
}
