import path from "node:path"
import { spawn } from "node:child_process"
import {
  isGitRepo,
  currentBranch,
  commitAll as gitCommitAll
} from "../util/git.mjs"
import { gitSnapshotTool } from "./git-auto.mjs"
import { isFullAutoMode, getPolicyMode } from "../permission/exec-policy.mjs"

/**
 * 全自动化 Git 操作工具
 * 
 * 当启用 full_auto 模式时，AI 可以：
 * 1. 自动 stage 更改 (git add)
 * 2. 自动创建提交 (git commit)
 * 3. 自动推送到远程 (git push)
 * 4. 执行其他 Git 操作
 * 
 * 警告：此模式会赋予 AI 更大的权限，可能导致不可逆的操作。
 * 建议仅在受控环境或 CI/CD 场景中使用。
 */

/**
 * 执行 Git 命令
 */
async function runGit(args, cwd, timeoutMs = 30000) {
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
      if (done) return
      done = true
      child.kill()
      resolve({ ok: false, stdout, stderr: "git command timed out", error: "timeout" })
    }, timeoutMs)
    child.stdout.on("data", (buf) => { stdout += String(buf) })
    child.stderr.on("data", (buf) => { stderr += String(buf) })
    child.on("error", (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: err.message, error: err.message })
    })
    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/**
 * 生成提交信息
 * 基于更改内容自动生成符合 Conventional Commits 格式的消息
 */
async function generateCommitMessage(cwd, customMessage = null) {
  if (customMessage) return customMessage

  // 获取变更的概要
  const result = await runGit(["status", "--short"], cwd)
  if (!result.ok) return "chore: update files"

  const files = result.stdout.split("\n").filter(Boolean)
  if (files.length === 0) return "chore: empty commit"

  // 分析文件类型来确定提交类型
  const hasTests = files.some(f => f.includes("test") || f.includes("spec"))
  const hasDocs = files.some(f => f.endsWith(".md") || f.includes("doc"))
  const hasConfig = files.some(f => 
    f.includes("config") || 
    f.endsWith(".json") || 
    f.endsWith(".yaml") || 
    f.endsWith(".yml")
  )

  let type = "chore"
  if (hasTests) type = "test"
  else if (hasDocs) type = "docs"
  else if (hasConfig) type = "chore"
  else if (files.some(f => f.includes("fix") || f.includes("bug"))) type = "fix"
  else if (files.some(f => f.includes("feat") || f.includes("feature"))) type = "feat"
  else if (files.length > 5) type = "refactor"

  // 生成描述
  let description
  if (files.length === 1) {
    const file = files[0].slice(3) // 移除状态前缀
    description = `update ${path.basename(file)}`
  } else {
    const scope = files.length <= 3 
      ? files.map(f => path.basename(f.slice(3))).join(", ")
      : `${files.length} files`
    description = `update ${scope}`
  }

  return `${type}: ${description}`
}

// ============================================================================
// Tool: git_auto_commit - 全自动提交
// ============================================================================

export const gitAutoCommitTool = {
  name: "git_auto_commit",
  description: "[FULL-AUTO MODE] Automatically stage all changes and create a git commit. Only available when git_auto.full_auto and git_auto.auto_commit are enabled. This operation cannot be undone without git restore.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Commit message (optional, will be auto-generated if not provided)"
      },
      stage_all: {
        type: "boolean",
        description: "Stage all changes including untracked files (default: true)"
      },
      amend: {
        type: "boolean",
        description: "Amend the previous commit instead of creating a new one (default: false)"
      },
      no_verify: {
        type: "boolean",
        description: "Bypass pre-commit hooks (default: false)"
      }
    },
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    // 检查全自动化模式
    if (!isFullAutoMode(ctx.config)) {
      return {
        ok: false,
        error: "full_auto_disabled",
        message: "Full-auto mode is not enabled. Set git_auto.full_auto: true and git_auto.auto_commit: true in your config."
      }
    }

    if (ctx.config?.git_auto?.auto_commit !== true) {
      return {
        ok: false,
        error: "auto_commit_disabled",
        message: "Auto commit is not enabled. Set git_auto.auto_commit: true in your config."
      }
    }

    // 检查是否是 Git 仓库
    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    // 检查是否有更改
    const statusResult = await runGit(["status", "--porcelain"], cwd)
    if (!statusResult.ok) {
      return {
        ok: false,
        error: "status_check_failed",
        message: statusResult.error
      }
    }

    if (!statusResult.stdout.trim()) {
      return {
        ok: true,
        skipped: true,
        message: "No changes to commit"
      }
    }

    // 1. 创建快照（用于可能的回滚）
    const snapshotResult = await gitSnapshotTool.execute(
      { auto: true, message: "Pre-auto-commit snapshot" },
      { cwd, sessionId: ctx.sessionId, config: ctx.config }
    )

    const snapshotId = snapshotResult.ok ? snapshotResult.snapshot?.id : null

    // 2. Stage 更改
    const stageAll = args.stage_all !== false // 默认 true
    if (stageAll) {
      const addResult = await runGit(["add", "-A"], cwd)
      if (!addResult.ok) {
        return {
          ok: false,
          error: "stage_failed",
          message: `Failed to stage changes: ${addResult.stderr}`,
          snapshotId
        }
      }
    }

    // 3. 生成或获取提交信息
    const message = await generateCommitMessage(cwd, args.message)

    // 4. 创建提交
    const commitArgs = ["commit", "-m", message]
    if (args.amend) commitArgs.push("--amend")
    if (args.no_verify) commitArgs.push("--no-verify")

    const commitResult = await runGit(commitArgs, cwd)
    if (!commitResult.ok) {
      return {
        ok: false,
        error: "commit_failed",
        message: `Failed to create commit: ${commitResult.stderr}`,
        snapshotId,
        staged: stageAll
      }
    }

    // 5. 获取提交信息
    const logResult = await runGit(["log", "-1", "--format=%H|%s"], cwd)
    const [hash, subject] = logResult.ok 
      ? logResult.stdout.split("|")
      : ["", message]

    return {
      ok: true,
      commit: {
        hash: hash?.slice(0, 8),
        fullHash: hash,
        message: subject || message,
        branch: await currentBranch(cwd)
      },
      snapshotId,
      staged: stageAll,
      message: `Created commit ${hash?.slice(0, 8)}: ${subject || message}`,
      warning: "This is an automatic commit. Use git_restore with the snapshot_id to revert if needed."
    }
  }
}

// ============================================================================
// Tool: git_auto_push - 全自动推送
// ============================================================================

export const gitAutoPushTool = {
  name: "git_auto_push",
  description: "[FULL-AUTO MODE] Automatically push commits to remote. Only available when git_auto.full_auto and git_auto.auto_push are enabled. WARNING: This will upload your changes to remote repository.",
  inputSchema: {
    type: "object",
    properties: {
      remote: {
        type: "string",
        description: "Remote name (default: origin)"
      },
      branch: {
        type: "string",
        description: "Branch name (default: current branch)"
      },
      force: {
        type: "boolean",
        description: "Force push (DANGEROUS, only works if allow_dangerous_ops is also enabled) (default: false)"
      },
      set_upstream: {
        type: "boolean",
        description: "Set upstream for new branch (default: true)"
      }
    },
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    // 检查全自动化模式
    if (!isFullAutoMode(ctx.config)) {
      return {
        ok: false,
        error: "full_auto_disabled",
        message: "Full-auto mode is not enabled. Set git_auto.full_auto: true and git_auto.auto_push: true in your config."
      }
    }

    if (ctx.config?.git_auto?.auto_push !== true) {
      return {
        ok: false,
        error: "auto_push_disabled",
        message: "Auto push is not enabled. Set git_auto.auto_push: true in your config."
      }
    }

    // 检查是否是 Git 仓库
    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const remote = args.remote || "origin"
    const branch = args.branch || await currentBranch(cwd)

    if (!branch) {
      return {
        ok: false,
        error: "no_branch",
        message: "Could not determine current branch"
      }
    }

    // 检查是否需要设置 upstream
    const setUpstream = args.set_upstream !== false && branch !== "main" && branch !== "master"

    // 构建 push 命令
    const pushArgs = ["push"]
    if (args.force) {
      if (ctx.config?.git_auto?.allow_dangerous_ops !== true) {
        return {
          ok: false,
          error: "force_push_forbidden",
          message: "Force push is forbidden. Enable git_auto.allow_dangerous_ops: true to allow force push."
        }
      }
      pushArgs.push("--force")
    }
    if (setUpstream) pushArgs.push("-u")
    pushArgs.push(remote, branch)

    const pushResult = await runGit(pushArgs, cwd)
    if (!pushResult.ok) {
      return {
        ok: false,
        error: "push_failed",
        message: `Failed to push: ${pushResult.stderr}`
      }
    }

    return {
      ok: true,
      pushed: {
        remote,
        branch,
        force: !!args.force
      },
      output: pushResult.stdout,
      message: `Pushed ${branch} to ${remote}${args.force ? " (forced)" : ""}`,
      warning: args.force ? "Force push was used. This may have overwritten remote history." : undefined
    }
  }
}

// ============================================================================
// Tool: git_auto_stage - 自动暂存
// ============================================================================

export const gitAutoStageTool = {
  name: "git_auto_stage",
  description: "[FULL-AUTO MODE] Automatically stage files for commit. Available when git_auto.full_auto is enabled.",
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        description: "Specific files to stage (default: all changes)"
      },
      all: {
        type: "boolean",
        description: "Stage all changes including untracked files (default: true if files not specified)"
      }
    },
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()

    // 检查全自动化模式
    if (!isFullAutoMode(ctx.config)) {
      return {
        ok: false,
        error: "full_auto_disabled",
        message: "Full-auto mode is not enabled. Set git_auto.full_auto: true in your config."
      }
    }

    if (!(await isGitRepo(cwd))) {
      return {
        ok: false,
        error: "not_a_git_repo",
        message: "Current directory is not a git repository"
      }
    }

    const hasSpecificFiles = Array.isArray(args.files) && args.files.length > 0
    const stageAll = !hasSpecificFiles && (args.all !== false)

    let result
    if (hasSpecificFiles) {
      result = await runGit(["add", "--", ...args.files], cwd)
    } else if (stageAll) {
      result = await runGit(["add", "-A"], cwd)
    } else {
      return {
        ok: false,
        error: "nothing_to_stage",
        message: "No files specified and all: false"
      }
    }

    if (!result.ok) {
      return {
        ok: false,
        error: "stage_failed",
        message: result.stderr
      }
    }

    // 获取 staged 文件列表
    const diffResult = await runGit(["diff", "--staged", "--name-only"], cwd)
    const stagedFiles = diffResult.ok 
      ? diffResult.stdout.split("\n").filter(Boolean)
      : []

    return {
      ok: true,
      staged: stagedFiles,
      message: `Staged ${stagedFiles.length} file(s) for commit`
    }
  }
}

// ============================================================================
// Tool: git_full_auto_status - 获取全自动化模式状态
// ============================================================================

export const gitFullAutoStatusTool = {
  name: "git_full_auto_status",
  description: "Check the full-auto mode status and available operations. Shows current configuration and what operations are permitted.",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  async execute(args, ctx) {
    const cwd = ctx.cwd || process.cwd()
    const policyMode = getPolicyMode(ctx.config)
    const isGit = await isGitRepo(cwd)

    return {
      ok: true,
      mode: policyMode.mode,
      restrictions: policyMode.restrictions,
      isGitRepo: isGit,
      config: {
        full_auto: ctx.config?.git_auto?.full_auto === true,
        auto_commit: ctx.config?.git_auto?.auto_commit === true,
        auto_push: ctx.config?.git_auto?.auto_push === true,
        auto_stage: ctx.config?.git_auto?.auto_stage !== false,
        allow_dangerous_ops: ctx.config?.git_auto?.allow_dangerous_ops === true
      },
      available_tools: [
        ...(ctx.config?.git_auto?.full_auto ? ["git_auto_stage"] : []),
        ...(ctx.config?.git_auto?.full_auto && ctx.config?.git_auto?.auto_commit ? ["git_auto_commit"] : []),
        ...(ctx.config?.git_auto?.full_auto && ctx.config?.git_auto?.auto_push ? ["git_auto_push"] : []),
        "git_snapshot",
        "git_restore",
        "git_info",
        "git_status"
      ]
    }
  }
}

// ============================================================================
// 导出所有全自动化工具
// ============================================================================

export const gitFullAutoTools = [
  gitAutoCommitTool,
  gitAutoPushTool,
  gitAutoStageTool,
  gitFullAutoStatusTool
]
