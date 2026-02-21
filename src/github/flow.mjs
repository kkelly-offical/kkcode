import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { ensureGitHubAuth, getStoredToken } from "./auth.mjs"
import { listUserRepos, searchRepos, listBranches } from "./api.mjs"
import { ensureRepo, isLocalRepo, listLocalRepos, localBranches, repoLocalPath } from "./workspace.mjs"

function timeAgo(dateStr) {
  if (!dateStr) return ""
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function padEnd(str, len) {
  return str.length >= len ? str : str + " ".repeat(len - str.length)
}

function printRepoList(repos, localSet) {
  const maxNameLen = Math.min(40, Math.max(...repos.map((r) => r.full_name.length)))
  for (let i = 0; i < repos.length; i++) {
    const r = repos[i]
    const idx = `  \x1b[2m${String(i + 1).padStart(2)}.\x1b[0m `
    const name = padEnd(r.full_name, maxNameLen + 2)
    const local = localSet.has(r.full_name) ? "\x1b[32m[local]\x1b[0m " : "        "
    const stars = r.stars > 0 ? `\x1b[33m★${r.stars}\x1b[0m` : ""
    const priv = r.private ? " \x1b[31m●\x1b[0m" : ""
    const time = `\x1b[2m${timeAgo(r.pushed_at)}\x1b[0m`
    console.log(`${idx}${name}${local}${stars}${priv}  ${time}`)
  }
}

function printBranchList(branches, localSet, defaultBranch) {
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]
    const idx = `  \x1b[2m${String(i + 1).padStart(2)}.\x1b[0m `
    const isDefault = b.name === defaultBranch ? " \x1b[2m(default)\x1b[0m" : ""
    const local = localSet.has(b.name) ? " \x1b[32m[local]\x1b[0m" : ""
    const prot = b.protected ? " \x1b[33m🔒\x1b[0m" : ""
    console.log(`${idx}${b.name}${isDefault}${local}${prot}`)
  }
}

async function prompt(rl, message) {
  const answer = await rl.question(`\x1b[36m  > ${message}\x1b[0m`)
  return answer.trim()
}

export async function runGitHubFlow() {
  const { token, login } = await ensureGitHubAuth()

  const rl = createInterface({ input, output })

  try {
    // --- Repo selection ---
    const localRepoList = await listLocalRepos()
    const localRepoSet = new Set(localRepoList)

    console.log(`\x1b[2m  👤 @${login}\x1b[0m`)
    console.log(`\n\x1b[1m  📦 你的仓库:\x1b[0m \x1b[2m(输入序号选择，或输入关键词搜索)\x1b[0m\n`)

    let repos = await listUserRepos(token)
    printRepoList(repos, localRepoSet)

    let selectedRepo = null
    while (!selectedRepo) {
      const input = await prompt(rl, "")
      if (!input) continue

      const num = parseInt(input, 10)
      if (!isNaN(num) && num >= 1 && num <= repos.length) {
        selectedRepo = repos[num - 1]
      } else {
        // Search
        console.log(`\n\x1b[2m  搜索 "${input}" ...\x1b[0m\n`)
        repos = await searchRepos(token, input, login)
        if (repos.length === 0) {
          console.log("  \x1b[31m未找到匹配的仓库\x1b[0m\n")
          repos = await listUserRepos(token)
          printRepoList(repos, localRepoSet)
        } else {
          printRepoList(repos, localRepoSet)
        }
      }
    }

    // --- Branch selection ---
    console.log(`\n\x1b[1m  🌿 分支:\x1b[0m \x1b[2m${selectedRepo.full_name}\x1b[0m\n`)

    const branches = await listBranches(token, selectedRepo.owner, selectedRepo.name)
    const localPath = repoLocalPath(selectedRepo.full_name)
    const existsLocally = await isLocalRepo(selectedRepo.full_name)
    const localBranchSet = new Set(existsLocally ? await localBranches(localPath) : [])

    // Sort: default branch first, then local branches, then the rest
    branches.sort((a, b) => {
      if (a.name === selectedRepo.default_branch) return -1
      if (b.name === selectedRepo.default_branch) return 1
      const aLocal = localBranchSet.has(a.name) ? 0 : 1
      const bLocal = localBranchSet.has(b.name) ? 0 : 1
      return aLocal - bLocal
    })

    printBranchList(branches, localBranchSet, selectedRepo.default_branch)

    let selectedBranch = null
    while (!selectedBranch) {
      const input = await prompt(rl, "选择分支: ")
      if (!input) continue

      const num = parseInt(input, 10)
      if (!isNaN(num) && num >= 1 && num <= branches.length) {
        selectedBranch = branches[num - 1].name
      } else {
        // Direct branch name input
        const match = branches.find((b) => b.name === input)
        if (match) {
          selectedBranch = match.name
        } else {
          console.log(`  \x1b[31m未找到分支 "${input}"\x1b[0m`)
        }
      }
    }

    rl.close()

    // --- Clone or pull ---
    const isExisting = existsLocally
    if (isExisting) {
      console.log(`\n\x1b[36m  📥 本地已有，同步 ${selectedRepo.full_name}@${selectedBranch} ...\x1b[0m`)
    } else {
      console.log(`\n\x1b[36m  📥 Cloning ${selectedRepo.full_name}@${selectedBranch} ...\x1b[0m`)
    }

    const result = await ensureRepo({
      fullName: selectedRepo.full_name,
      branch: selectedBranch,
      token
    })

    console.log(`  \x1b[2m→ ${result.path}\x1b[0m`)
    console.log(`\x1b[32m  ✓ 就绪\x1b[0m\n`)

    return { cwd: result.path }
  } finally {
    rl.close()
  }
}
