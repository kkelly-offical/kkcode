import path from "node:path"
import { lstat, realpath } from "node:fs/promises"

export class WorkspacePathError extends Error {
  constructor(message, details = {}) {
    super(message)
    const { root, requested, resolved } = /** @type {{root?: string, requested?: string, resolved?: string}} */ (details)
    this.name = "WorkspacePathError"
    this.code = "workspace_path_violation"
    this.root = root
    this.requested = requested
    this.resolved = resolved
  }
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function nearestExistingAncestor(target) {
  let current = target
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

/**
 * Resolve a user-supplied path inside a workspace.
 *
 * Both the lexical path and the nearest existing ancestor's real path are
 * checked. The second check prevents an in-workspace symlink from redirecting
 * reads or newly-created files outside the workspace.
 */
export async function resolveWorkspacePath(root, requested = ".", { mustExist = false } = {}) {
  const lexicalRoot = path.resolve(String(root || process.cwd()))
  const raw = String(requested ?? ".")
  const lexicalTarget = path.resolve(lexicalRoot, raw || ".")

  if (!isWithin(lexicalTarget, lexicalRoot)) {
    throw new WorkspacePathError(
      `path traversal blocked: ${raw || "."} is outside working directory`,
      { root: lexicalRoot, requested: raw, resolved: lexicalTarget }
    )
  }

  const realRoot = await realpath(lexicalRoot)
  let realTarget = null
  try {
    realTarget = await realpath(lexicalTarget)
  } catch (error) {
    if (mustExist || (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")) throw error
  }

  const existing = realTarget ? lexicalTarget : await nearestExistingAncestor(lexicalTarget)
  const realExisting = realTarget || await realpath(existing)
  if (!isWithin(realExisting, realRoot)) {
    throw new WorkspacePathError(
      `symlink escape blocked: ${raw || "."} resolves outside working directory`,
      { root: realRoot, requested: raw, resolved: realExisting }
    )
  }

  return lexicalTarget
}

export class WorkspaceFs {
  constructor(root) {
    this.root = path.resolve(String(root || process.cwd()))
  }

  resolve(requested = ".", options = {}) {
    return resolveWorkspacePath(this.root, requested, options)
  }
}

export function isWorkspacePathError(error) {
  return error instanceof WorkspacePathError || error?.code === "workspace_path_violation"
}
