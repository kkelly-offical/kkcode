import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { ensureGitHubAuth } from "./auth.mjs"
import { listUserRepos, searchRepos, listBranches } from "./api.mjs"
import { ensureRepo, isLocalRepo, listLocalRepos, localBranches, repoLocalPath, removeLocalRepo, syncRepo, hasLocalChanges, getChangedFiles, generateCommitMessage, commitAndPush } from "./workspace.mjs"

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

    // --- Local repo action selection ---
    let action = "clone"
    if (existsLocally) {
      console.log(`\n\x1b[33m  📦 本地已存在仓库 ${selectedRepo.full_name}\x1b[0m\n`)
      console.log("  请选择操作：")
      console.log("    \x1b[36m1.\x1b[0m 使用本地仓库（不更新）")
      console.log("    \x1b[36m2.\x1b[0m 同步云端最新代码（git pull）")
      console.log("    \x1b[36m3.\x1b[0m 强制重新克隆（删除本地，重新下载）")
      console.log("")

      while (true) {
        const choice = await prompt(rl, "选择操作 (1-3): ")
        if (choice === "1") {
          action = "use-local"
          break
        } else if (choice === "2") {
          action = "sync"
          break
        } else if (choice === "3") {
          action = "reclone"
          break
        } else {
          console.log("  \x1b[31m请输入 1、2 或 3\x1b[0m")
        }
      }
    }

    rl.close()

    // --- Execute action ---
    let result
    if (action === "use-local") {
      console.log(`\n\x1b[36m  📂 使用本地仓库 ${selectedRepo.full_name}@${selectedBranch} ...\x1b[0m`)
      const localPath = repoLocalPath(selectedRepo.full_name)
      // Just checkout the branch if needed
      const localBranchList = await localBranches(localPath)
      if (!localBranchList.includes(selectedBranch)) {
        console.log(`  \x1b[33m⚠ 本地没有分支 ${selectedBranch}，切换到默认分支\x1b[0m`)
        selectedBranch = selectedRepo.default_branch
      }
      result = { path: localPath, isNew: false, action: "use-local" }
    } else if (action === "sync") {
      console.log(`\n\x1b[36m  📥 同步云端代码 ${selectedRepo.full_name}@${selectedBranch} ...\x1b[0m`)
      result = await syncRepo({
        fullName: selectedRepo.full_name,
        branch: selectedBranch,
        token
      })
      result.action = "sync"
    } else if (action === "reclone") {
      console.log(`\n\x1b[36m  🗑️  删除本地仓库...\x1b[0m`)
      await removeLocalRepo(selectedRepo.full_name)
      console.log(`\x1b[36m  📥 重新克隆 ${selectedRepo.full_name}@${selectedBranch} ...\x1b[0m`)
      result = await ensureRepo({
        fullName: selectedRepo.full_name,
        branch: selectedBranch,
        token
      })
      result.action = "reclone"
    } else {
      // Clone new repo
      console.log(`\n\x1b[36m  📥 克隆仓库 ${selectedRepo.full_name}@${selectedBranch} ...\x1b[0m`)
      result = await ensureRepo({
        fullName: selectedRepo.full_name,
        branch: selectedBranch,
        token
      })
      result.action = "clone"
    }

    console.log(`  \x1b[2m→ ${result.path}\x1b[0m`)
    console.log(`\x1b[32m  ✓ 就绪\x1b[0m\n`)

    return { cwd: result.path }
  } finally {
    rl.close()
  }
}

/**
 * REPL 退出后询问用户是否推送代码到 GitHub
 * @param {Object} flowResult - runGitHubFlow 返回的结果
 */
export async function promptPushChanges(flowResult) {
  const { cwd } = flowResult
  if (!cwd) return

  // Check if there are any changes
  const hasChanges = await hasLocalChanges(cwd)
  if (!hasChanges) {
    console.log("\n\x1b[2m  没有检测到代码变更\x1b[0m")
    return
  }

  // Get changed files for display
  const changedFiles = await getChangedFiles(cwd)
  console.log("\n\x1b[33m  📦 检测到代码变更:\x1b[0m\n")
  for (const file of changedFiles.slice(0, 10)) {
    console.log(`    \x1b[36m${file}\x1b[0m`)
  }
  if (changedFiles.length > 10) {
    console.log(`    \x1b[2m... 还有 ${changedFiles.length - 10} 个文件\x1b[0m`)
  }
  console.log("")

  // Create readline interface
  const rl = createInterface({ input, output })

  try {
    // Ask user what to do
    console.log("\x1b[1m  是否推送到 GitHub?\x1b[0m\n")
    console.log("    \x1b[36m1.\x1b[0m 推送变更到云端 (commit & push)")
    console.log("    \x1b[36m2.\x1b[0m 放弃变更，保持云端版本")
    console.log("    \x1b[36m3.\x1b[0m 稍后手动处理\n")

    let choice = null
    while (!choice) {
      const answer = await rl.question(`\x1b[36m  > 选择 (1-3): \x1b[0m`)
      const trimmed = answer.trim()
      if (trimmed === "1" || trimmed === "2" || trimmed === "3") {
        choice = trimmed
      } else {
        console.log("  \x1b[31m请输入 1、2 或 3\x1b[0m")
      }
    }

    if (choice === "1") {
      // Get current branch
      const { execFile } = await import("node:child_process")
      const currentBranch = await new Promise((resolve) => {
        execFile("git", ["branch", "--show-current"], { cwd }, (err, stdout) => {
          resolve(err ? "main" : stdout.trim())
        })
      })

      // Get commit message (use default or ask user)
      const defaultMessage = await generateCommitMessage(cwd)
      const customMessage = await rl.question(`\x1b[36m  > 提交信息 [${defaultMessage}]: \x1b[0m`)
      const message = customMessage.trim() || defaultMessage

      // Get token
      const { getStoredToken: getToken } = await import("./auth.mjs")
      const { token } = await getToken() || {}
      if (!token) {
        console.log("\n  \x1b[31m错误: 未找到 GitHub Token，无法推送\x1b[0m")
        return
      }

      console.log("\n  \x1b[36m📤 正在推送...\x1b[0m")
      try {
        await commitAndPush({ repoPath: cwd, message, branch: currentBranch, token })
        console.log(`\x1b[32m  ✓ 已成功推送到 GitHub (${currentBranch})\x1b[0m\n`)
      } catch (error) {
        console.log(`\x1b[31m  ✗ 推送失败: ${error.message}\x1b[0m\n`)
      }
    } else if (choice === "2") {
      console.log("\n  \x1b[33m⚠ 已放弃本地变更\x1b[0m\n")
      // Optionally reset the repo
      const { execFile } = await import("node:child_process")
      await new Promise((resolve) => {
        execFile("git", ["reset", "--hard", "HEAD"], { cwd }, () => resolve())
      })
    } else {
      console.log("\n  \x1b[2m已跳过推送，您稍后可以使用 git 命令手动处理\x1b[0m\n")
    }
  } finally {
    rl.close()
  }
}
