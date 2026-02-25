/**
 * C1: LongAgent Git 生命周期 — 共享的 Git 分支创建/阶段提交/合并逻辑
 * 被 longagent.mjs、longagent-4stage.mjs、longagent-hybrid.mjs 共同使用
 */
import * as git from "../util/git.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

/**
 * 创建 Git 特性分支（含 stash/unstash）
 * @returns {{ gitBranch, gitBaseBranch, gitActive, gateStatus }}
 */
export async function setupGitBranch({ sessionId, prompt, cwd }) {
  const gitBaseBranch = await git.currentBranch(cwd)
  if (!gitBaseBranch || gitBaseBranch === "HEAD") {
    return { gitBranch: null, gitBaseBranch: null, gitActive: false, gateStatus: { status: "warn", reason: "detached HEAD or no branch" } }
  }
  const branchName = git.generateBranchName(sessionId, prompt)
  const clean = await git.isClean(cwd)
  let stashed = false
  try {
    if (!clean) {
      const sr = await git.stash("kkcode-auto-stash", cwd)
      stashed = sr.ok
      if (!stashed) {
        return { gitBranch: null, gitBaseBranch, gitActive: false, gateStatus: { status: "warn", reason: "git stash failed" } }
      }
    }
    const created = await git.createBranch(branchName, cwd)
    if (created.ok) {
      await EventBus.emit({ type: EVENT_TYPES.LONGAGENT_GIT_BRANCH_CREATED, sessionId, payload: { branch: branchName, baseBranch: gitBaseBranch } })
      return { gitBranch: branchName, gitBaseBranch, gitActive: true, gateStatus: { status: "pass", branch: branchName, baseBranch: gitBaseBranch } }
    }
    return { gitBranch: null, gitBaseBranch, gitActive: false, gateStatus: { status: "warn", reason: created.message } }
  } finally {
    if (stashed) await git.stashPop(cwd).catch(() => {})
  }
}
