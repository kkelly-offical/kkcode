import { execFile } from "node:child_process"
import { mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { githubReposDir } from "../storage/paths.mjs"

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr
        reject(err)
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

export function repoLocalPath(fullName) {
  const [owner, repo] = fullName.split("/")
  return path.join(githubReposDir(), owner, repo)
}

export async function isLocalRepo(fullName) {
  try {
    const p = repoLocalPath(fullName)
    const s = await stat(path.join(p, ".git"))
    return s.isDirectory()
  } catch {
    return false
  }
}

export async function ensureRepo({ fullName, branch, token }) {
  const localPath = repoLocalPath(fullName)
  const exists = await isLocalRepo(fullName)

  if (!exists) {
    // Clone
    await mkdir(path.dirname(localPath), { recursive: true })
    const cloneUrl = `https://${token}@github.com/${fullName}.git`
    await exec("git", ["clone", "--depth", "1", "-b", branch, "--single-branch", cloneUrl, localPath])
    // Remove token from remote URL
    const cleanUrl = `https://github.com/${fullName}.git`
    await exec("git", ["remote", "set-url", "origin", cleanUrl], { cwd: localPath })
    // Store token in git credential for this repo
    await configureCredential(localPath, token)
    return { path: localPath, isNew: true }
  }

  // Existing repo — fetch & checkout
  await configureCredential(localPath, token)
  await exec("git", ["fetch", "origin"], { cwd: localPath })

  // Check if branch exists locally
  const localBranchList = await localBranches(localPath)
  if (localBranchList.includes(branch)) {
    await exec("git", ["checkout", branch], { cwd: localPath })
    await exec("git", ["pull", "--ff-only", "origin", branch], { cwd: localPath }).catch(() => {
      // pull may fail if diverged, that's ok
    })
  } else {
    // Checkout remote branch
    await exec("git", ["checkout", "-b", branch, `origin/${branch}`], { cwd: localPath })
  }

  return { path: localPath, isNew: false }
}

async function configureCredential(repoPath, token) {
  // Use store credential helper scoped to this repo
  const credentialPath = path.join(repoPath, ".git", "kkcode-credentials")
  const { writeFile } = await import("node:fs/promises")
  await writeFile(credentialPath, `https://x-access-token:${token}@github.com\n`, "utf8")
  await exec("git", ["config", "credential.helper", `store --file="${credentialPath}"`], { cwd: repoPath })
}

export async function listLocalRepos() {
  const root = githubReposDir()
  const repos = []
  try {
    const owners = await readdir(root)
    for (const owner of owners) {
      const ownerPath = path.join(root, owner)
      const ownerStat = await stat(ownerPath).catch(() => null)
      if (!ownerStat || !ownerStat.isDirectory()) continue
      const names = await readdir(ownerPath)
      for (const name of names) {
        const gitDir = path.join(ownerPath, name, ".git")
        const gitStat = await stat(gitDir).catch(() => null)
        if (gitStat && gitStat.isDirectory()) {
          repos.push(`${owner}/${name}`)
        }
      }
    }
  } catch {
    // repos dir doesn't exist yet
  }
  return repos
}

export async function localBranches(repoPath) {
  try {
    const out = await exec("git", ["branch", "--list", "--format=%(refname:short)"], { cwd: repoPath })
    return out.split("\n").filter(Boolean)
  } catch {
    return []
  }
}
