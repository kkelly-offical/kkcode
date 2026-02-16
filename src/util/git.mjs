import { spawn } from "node:child_process"

const GIT_TIMEOUT_MS = 30000

function run(args, cwd = process.cwd(), timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let done = false

    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    })

    const timer = setTimeout(() => {
      done = true
      child.kill()
      resolve({ ok: false, stdout, stderr: "git command timed out", code: null })
    }, timeoutMs)

    child.stdout.on("data", (buf) => { stdout += String(buf) })
    child.stderr.on("data", (buf) => { stderr += String(buf) })

    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: error.message, code: null })
    })

    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code })
    })
  })
}

/** Check if cwd is inside a git repo */
export async function isGitRepo(cwd = process.cwd()) {
  const result = await run(["rev-parse", "--is-inside-work-tree"], cwd)
  return result.ok && result.stdout.trim() === "true"
}

/** Get current branch name */
export async function currentBranch(cwd = process.cwd()) {
  const result = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  return result.ok ? result.stdout.trim() : null
}

/** Check if working tree is clean */
export async function isClean(cwd = process.cwd()) {
  const result = await run(["status", "--porcelain"], cwd)
  return result.ok && !result.stdout.trim()
}

/** Create and checkout a new branch */
export async function createBranch(name, cwd = process.cwd()) {
  const result = await run(["checkout", "-b", name], cwd)
  return { ok: result.ok, message: result.ok ? `created branch: ${name}` : result.stderr }
}

/** Checkout an existing branch */
export async function checkoutBranch(name, cwd = process.cwd()) {
  const result = await run(["checkout", name], cwd)
  return { ok: result.ok, message: result.ok ? `switched to: ${name}` : result.stderr }
}

/** Stage all changes and commit */
export async function commitAll(message, cwd = process.cwd()) {
  const add = await run(["add", "-A"], cwd)
  if (!add.ok) return { ok: false, message: `git add failed: ${add.stderr}` }
  const commit = await run(["commit", "-m", message, "--allow-empty"], cwd)
  if (!commit.ok) {
    // Nothing to commit is not an error
    if (commit.stderr.includes("nothing to commit")) {
      return { ok: true, message: "nothing to commit", empty: true }
    }
    return { ok: false, message: `git commit failed: ${commit.stderr}` }
  }
  return { ok: true, message: commit.stdout.split("\n")[0] || "committed" }
}

/** Merge a branch into current branch */
export async function mergeBranch(source, cwd = process.cwd()) {
  const result = await run(["merge", source, "--no-ff", "-m", `Merge branch '${source}'`], cwd)
  return { ok: result.ok, message: result.ok ? `merged ${source}` : result.stderr }
}

/** Delete a branch */
export async function deleteBranch(name, cwd = process.cwd()) {
  const result = await run(["branch", "-d", name], cwd)
  return { ok: result.ok, message: result.ok ? `deleted branch: ${name}` : result.stderr }
}

/** Get short log of recent commits */
export async function recentCommits(count = 5, cwd = process.cwd()) {
  const result = await run(["log", `--oneline`, `-${count}`], cwd)
  return result.ok ? result.stdout.trim().split("\n").filter(Boolean) : []
}

/** Get diff stat summary */
export async function diffStat(cwd = process.cwd()) {
  const result = await run(["diff", "--stat", "HEAD"], cwd)
  return result.ok ? result.stdout.trim() : ""
}

/** Stash current changes */
export async function stash(message = "auto-stash", cwd = process.cwd()) {
  const result = await run(["stash", "push", "-m", message], cwd)
  return { ok: result.ok, message: result.ok ? result.stdout.trim() : result.stderr }
}

/** Pop stash */
export async function stashPop(cwd = process.cwd()) {
  const result = await run(["stash", "pop"], cwd)
  return { ok: result.ok, message: result.ok ? result.stdout.trim() : result.stderr }
}

/** Generate a branch name from session/objective */
export function generateBranchName(sessionId, objective = "") {
  const prefix = "kkcode"
  const shortId = String(sessionId || "").slice(0, 8)
  const slug = String(objective || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  return `${prefix}/${shortId}${slug ? "-" + slug : ""}`
}
