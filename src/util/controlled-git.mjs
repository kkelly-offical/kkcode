import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { access, realpath, stat } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"

const exec = promisify(execFile)
const disabled = process.platform === "win32" ? "NUL" : "/dev/null"
const extraKeys = new Set(["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
const commands = new Set(["rev-parse", "config", "ls-files", "ls-tree", "cat-file", "status", "diff", "diff-tree", "read-tree", "write-tree", "update-index", "hash-object", "add", "commit-tree", "update-ref", "apply", "worktree", "merge-base", "show", "log"])
let gitBinary

async function executable(cwd) {
  if (gitBinary) return gitBinary
  const root = await realpath(cwd)
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue
    const candidate = path.join(entry, process.platform === "win32" ? "git.exe" : "git")
    try {
      const resolved = await realpath(candidate), relative = path.relative(root, resolved)
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) continue
      if (!(await stat(resolved)).isFile()) continue
      await access(resolved, constants.X_OK)
      gitBinary = resolved
      return gitBinary
    } catch { /* Try the next host PATH entry; never search the task cwd. */ }
  }
  throw new Error("a trusted Git executable outside the task workspace is required")
}

function environment(extra) {
  const result = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "LANG", "LC_ALL"]
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(result, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: disabled, GIT_CONFIG_GLOBAL: disabled,
    GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1",
    GIT_PAGER: "", PAGER: ""
  })
  for (const [key, value] of Object.entries(extra || {})) {
    if (!extraKeys.has(key) && key !== "GIT_OPTIONAL_LOCKS") throw new Error("controlled Git does not accept arbitrary environment variables")
    result[key] = value
  }
  return result
}

const baseArgs = ["--no-pager", "-c", `core.hooksPath=${disabled}`, "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false", "-c", "submodule.recurse=false", "-c", "diff.external=",
  "-c", `core.attributesFile=${disabled}`, "-c", "color.ui=false"]

/** Host-side Git for governed snapshots/acceptance only. No repository hooks,
 * fsmonitor, filters, textconv/external diff, pager, or ambient provider secrets.
 * Explicit interactive Git commands can retain their normal separate behavior.
 * @param {string[]} args
 * @param {{cwd: string, env?: Record<string,string>, timeoutMs?: number, maxBuffer?: number}} options
 */
export async function runControlledGit(args, { cwd, env = {}, timeoutMs = 30000, maxBuffer = 64 * 1024 * 1024 }) {
  try {
    if (!Array.isArray(args) || !commands.has(args[0])) throw new Error("controlled Git supports only explicit local snapshot/inspection operations")
    const separator = args.indexOf("--")
    if (args.slice(1, separator < 0 ? undefined : separator).some(arg => arg === "--ext-diff" || arg === "--textconv")) throw new Error("controlled Git cannot enable repository diff executables")
    const command = await executable(cwd), commandEnv = environment(env)
    // Reading keys does not invoke filters. Disable every configured driver, so
    // project .gitattributes cannot activate its clean/smudge/process program.
    let keys = ""
    try {
      keys = (await exec(command, [...baseArgs, "config", "--name-only", "--get-regexp", "^(filter|diff)\\..*\\.(clean|smudge|process|required|textconv|command)$"], {
        cwd, env: commandEnv, encoding: "utf8", timeout: timeoutMs, maxBuffer, windowsHide: true
      })).stdout
    } catch (error) { if (error.code !== 1) throw error }
    const overrides = []
    const filters = new Set(), diffs = new Set()
    for (const key of keys.split(/\r?\n/).filter(Boolean)) {
      const match = /^(filter|diff)\.(.+)\.(clean|smudge|process|required|textconv|command)$/i.exec(key)
      if (!match || !/^[a-zA-Z0-9_.:/-]+$/.test(match[2])) throw new Error("repository uses an unsupported executable Git driver name")
      ;(match[1].toLowerCase() === "filter" ? filters : diffs).add(match[2])
    }
    for (const name of filters) for (const key of ["clean", "smudge", "process", "required"]) overrides.push("-c", `filter.${name}.${key}=${key === "required" ? "false" : ""}`)
    for (const name of diffs) for (const key of ["textconv", "command"]) overrides.push("-c", `diff.${name}.${key}=`)
    const safeArgs = args[0] === "diff" ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args
    const result = await exec(command, [...baseArgs, ...overrides, ...safeArgs], {
      cwd, env: commandEnv, encoding: "utf8", timeout: timeoutMs, maxBuffer, windowsHide: true
    })
    return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || error), code: Number.isInteger(error.code) ? error.code : null }
  }
}
