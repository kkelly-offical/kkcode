import { isGitRepo } from "../../util/git.mjs"
import { restoreGhostCommit } from "../../util/git.mjs"
import { getSessionSnapshots } from "./checkpoint.mjs"
import { askQuestionInteractive } from "../tool/question-prompt.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

/**
 * 只识别「现在执行撤销」的命令/祈使句，不做单纯关键词搜索。
 *
 * 这是一道行为边界：输入「How does git rollback work?」时应该让模型
 * 解释，不能弹出真实的代码回滚确认框。因此执行形态从句首匹配，
 * 讨论/问句形态先行排除。
 */
const ROLLBACK_PATTERNS = [
  // 高置信度 — 明确以撤销动作开始，允许常见礼貌前缀。
  {
    pattern: /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我|给我|现在|马上|立刻)?\s*(回退|撤销|撤回|回滚|还原)/i,
    confidence: 0.9
  },
  {
    pattern: /^(?:please[\s,]+)?(?:(?:can|could|would|will)\s+you\s+)?(undo|rollback|roll\s+back|revert)\b/i,
    confidence: 0.9
  },
  // 中置信度 — 不使用上面动词，但句子本身仍是明确指令。
  {
    pattern: /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我|现在)?\s*(恢复到|恢复之前|回到之前|退回|取消(?:刚才|上次|之前)的(?:修改|更改|变更|操作))/i,
    confidence: 0.8
  },
  {
    pattern: /^(?:please[\s,]+)?(?:(?:can|could|would|will)\s+you\s+)?(restore\s+(?:the\s+)?previous|go\s+back(?:\s+to\s+before)?)/i,
    confidence: 0.8
  },
  // 低置信度 — 口语化但仍是独立的取消指令。
  { pattern: /^(不要了|算了不改了|改回去|恢复原样)(?:\s|吧|。|!|！|$)/i, confidence: 0.7 }
]

const ROLLBACK_DISCUSSION_PATTERNS = [
  // 疑问词、解释/分析类动词出现在句首，表明用户要信息而不是执行。
  /^(?:how|what|why|when|where)\b/i,
  /^(?:please\s+)?(?:explain|describe|discuss|compare|analy[sz]e|tell\s+me|show\s+me)\b/i,
  /^(?:如何|怎么|怎样|为什么|为何|什么是|解释|说明|讲讲|介绍|分析|讨论|比较|对比)/,
  // 「rollback 的实现/原理」不一定以疑问词开头，也必须排除。
  /\b(?:undo|rollback|revert)\b.*\b(?:implementation|mechanism|semantics|meaning|works?)\b/i,
  /(?:回退|撤销|撤回|回滚|还原)(?:的)?(?:实现|原理|机制|逻辑|含义|区别|用法)/
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

  // 问号是「在询问」的强信号。自然语言回滚会引发真实文件
  // 操作，宁可让带问号的礼貌请求交给模型，也不把讨论误当指令。
  if (/[?？]/.test(normalized) || ROLLBACK_DISCUSSION_PATTERNS.some((pattern) => pattern.test(normalized))) {
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
 * @returns {Promise<{ confirmed: boolean, snapshotId: string|null, commitHash?: string|null, message: string }>}
 */
export async function confirmRollback({ cwd, sessionId, language = "en" }) {
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

  // /undo 必须严格限定当前会话。仓库级 latest 会让会话 A
  // 误撤销会话 B 的更新快照；缺少会话身份时也必须 fail closed。
  const snapshots = sessionId ? await getSessionSnapshots(sessionId, cwd) : []
  const latest = snapshots[0]
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
    "⚠ 注意: 回滚会覆盖快照中已知文件；之后新增的未跟踪文件会为避免误删而保留。已执行的 bash 命令（如安装依赖等）也无法自动撤销。"
  ].join("\n")

  const enWarning = [
    `Latest snapshot: ${shortHash} (${snapDate})`,
    `Contains ${fileCount} file(s): ${(latest.files || []).slice(0, 5).join(", ")}${fileCount > 5 ? " ..." : ""}`,
    "",
    "Warning: Rollback overwrites files known to the snapshot; later untracked files are retained to avoid data loss. Bash commands and other external side effects cannot be undone."
  ].join("\n")

  const answers = await askQuestionInteractive({
    sessionId,
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
 * @returns {Promise<{ ok: boolean, message: string }>}
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
        ? `已成功回滚到快照 ${commitHash.slice(0, 8)}。快照中的文件已恢复；为避免误删用户文件，之后新增的未跟踪文件会保留，已执行的 bash 命令也无法撤销。`
        : `Rolled back to snapshot ${commitHash.slice(0, 8)}. Snapshot files were restored; later untracked files are kept to avoid deleting user data, and executed bash commands cannot be undone.`
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
 * 在前台 REPL 的 executePromptTurn 入口调用
 *
 * @returns {Promise<{ handled: boolean, reply: string }>}
 *   handled=true 表示消息已被回溯流程处理，不需要再发给模型
 */
export async function handleRollbackIfNeeded({ prompt, cwd, sessionId, language = "en" }) {
  const intent = detectRollbackIntent(prompt)
  if (!intent.isRollback) {
    return { handled: false, reply: "" }
  }

  const confirmation = await confirmRollback({ cwd, sessionId, language })
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
