import { isGitRepo } from "../util/git.mjs"
import { getLatestGhostCommit, listGhostCommits } from "../storage/ghost-commit-store.mjs"
import { restoreGhostCommit } from "../util/git.mjs"
import { askQuestionInteractive } from "../tool/question-prompt.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

/**
 * 回溯意图检测关键词
 * 分为中文和英文两组，按置信度排序
 */
const ROLLBACK_PATTERNS = [
  // 高置信度 — 明确的回退指令（中文不用 \b，英文保留）
  { pattern: /(回退|撤销|撤回|回滚|还原)/i, confidence: 0.9 },
  { pattern: /\b(undo|rollback|revert)\b/i, confidence: 0.9 },
  // 中置信度 — 需要上下文
  { pattern: /(恢复到|恢复之前|回到之前|退回|取消(刚才|上次|之前)的(修改|更改|变更|操作))/i, confidence: 0.8 },
  { pattern: /\b(restore previous|go back|undo (last|previous|recent))\b/i, confidence: 0.8 },
  // 低置信度 — 可能是回退也可能不是
  { pattern: /(不要了|算了不改了|改回去|恢复原样)/i, confidence: 0.7 }
]

/**
 * 检测用户消息中的回溯意图
 * @param {string} text - 用户输入文本
 * @returns {{ isRollback: boolean, confidence: number, matchedPattern: string }}
 */
export function detectRollbackIntent(text) {
  if (!text || typeof text !== "string") {
    return { isRollback: false, confidence: 0, matchedPattern: "" }
  }

  const normalized = text.trim().toLowerCase()
  // 过短的消息不太可能是回退指令（除非就是 "undo" 这样的单词）
  if (normalized.length > 200) {
    return { isRollback: false, confidence: 0, matchedPattern: "" }
  }

  for (const { pattern, confidence } of ROLLBACK_PATTERNS) {
    const match = normalized.match(pattern)
    if (match) {
      return { isRollback: true, confidence, matchedPattern: match[0] }
    }
  }

  return { isRollback: false, confidence: 0, matchedPattern: "" }
}

/**
 * 向用户确认是否执行回滚，并展示可用快照
 * @returns {{ confirmed: boolean, snapshotId: string|null, message: string }}
 */
export async function confirmRollback({ cwd, language = "en" }) {
  const inGit = await isGitRepo(cwd)
  if (!inGit) {
    return {
      confirmed: false,
      snapshotId: null,
      message: language === "zh"
        ? "当前目录不是 Git 仓库，无法执行代码回滚。"
        : "Not a git repository — cannot rollback code changes."
    }
  }

  const latest = await getLatestGhostCommit(cwd)
  if (!latest) {
    return {
      confirmed: false,
      snapshotId: null,
      message: language === "zh"
        ? "没有找到可用的快照。本次会话尚未创建任何代码快照，无法回滚。"
        : "No snapshots found. No code snapshots were created in this session."
    }
  }

  const snapDate = new Date(latest.createdAt).toLocaleString()
  const fileCount = latest.files?.length || 0
  const shortHash = latest.commitHash?.slice(0, 8) || "unknown"

  const zhWarning = [
    `找到最近的快照: ${shortHash} (${snapDate})`,
    `包含 ${fileCount} 个文件: ${(latest.files || []).slice(0, 5).join(", ")}${fileCount > 5 ? " ..." : ""}`,
    "",
    "⚠ 注意: 回滚只能恢复文件变更。已执行的 bash 命令（如安装依赖、删除文件等）无法自动撤销。"
  ].join("\n")

  const enWarning = [
    `Latest snapshot: ${shortHash} (${snapDate})`,
    `Contains ${fileCount} file(s): ${(latest.files || []).slice(0, 5).join(", ")}${fileCount > 5 ? " ..." : ""}`,
    "",
    "Warning: Rollback only restores file changes. Bash commands (installs, deletions, etc.) cannot be undone."
  ].join("\n")

  const answers = await askQuestionInteractive({
    questions: [{
      id: "rollback_confirm",
      text: language === "zh" ? "确认回滚代码？" : "Confirm code rollback?",
      description: language === "zh" ? zhWarning : enWarning,
      options: [
        {
          label: language === "zh" ? "确认回滚" : "Confirm rollback",
          value: "yes",
          description: language === "zh"
            ? "恢复文件到快照状态"
            : "Restore files to snapshot state"
        },
        {
          label: language === "zh" ? "取消" : "Cancel",
          value: "no",
          description: language === "zh"
            ? "不执行回滚，继续当前对话"
            : "Skip rollback, continue conversation"
        }
      ],
      allowCustom: false
    }]
  })

  const answer = String(answers.rollback_confirm || "").toLowerCase().trim()
  const confirmed = ["yes", "confirm", "确认回滚", "1"].includes(answer)

  return {
    confirmed,
    snapshotId: confirmed ? latest.id : null,
    commitHash: confirmed ? latest.commitHash : null,
    message: confirmed
      ? (language === "zh" ? `正在回滚到快照 ${shortHash}...` : `Rolling back to snapshot ${shortHash}...`)
      : (language === "zh" ? "已取消回滚。" : "Rollback cancelled.")
  }
}

/**
 * 执行代码回滚
 * @returns {{ ok: boolean, message: string }}
 */
export async function executeRollback({ cwd, commitHash, sessionId, language = "en" }) {
  try {
    const result = await restoreGhostCommit(cwd, commitHash, false)
    if (!result.ok) {
      return {
        ok: false,
        message: language === "zh"
          ? `回滚失败: ${result.error}`
          : `Rollback failed: ${result.error}`
      }
    }

    await EventBus.emit({
      type: EVENT_TYPES.TURN_STEP_FINISH,
      sessionId,
      turnId: null,
      payload: { action: "rollback", commitHash }
    })

    return {
      ok: true,
      message: language === "zh"
        ? `已成功回滚到快照 ${commitHash.slice(0, 8)}。文件已恢复，但已执行的 bash 命令无法撤销。`
        : `Rolled back to snapshot ${commitHash.slice(0, 8)}. Files restored, but executed bash commands cannot be undone.`
    }
  } catch (err) {
    return {
      ok: false,
      message: language === "zh"
        ? `回滚异常: ${err.message}`
        : `Rollback error: ${err.message}`
    }
  }
}

/**
 * 完整的回溯流程：检测 → 确认 → 执行
 * 在 loop.mjs 的 processTurnLoop 入口调用
 *
 * @returns {{ handled: boolean, reply: string }}
 *   handled=true 表示消息已被回溯流程处理，不需要再发给模型
 */
export async function handleRollbackIfNeeded({ prompt, cwd, sessionId, language = "en" }) {
  const intent = detectRollbackIntent(prompt)
  if (!intent.isRollback) {
    return { handled: false, reply: "" }
  }

  const confirmation = await confirmRollback({ cwd, language })
  if (!confirmation.confirmed) {
    return { handled: true, reply: confirmation.message }
  }

  const result = await executeRollback({
    cwd,
    commitHash: confirmation.commitHash,
    sessionId,
    language
  })

  return { handled: true, reply: result.message }
}