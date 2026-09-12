import { getConversationHistory, replaceMessages } from "./store.mjs"

/**
 * 上下文回溯 —— 把会话退回上一轮之前。
 *
 * 成熟的编码智能体都有这个：说错了、模型跑偏了、或者只是想换个问法，
 * 应该能退回去重来，而不是被迫在一段已经歪掉的上下文里继续往前顶。
 *
 * **回溯的是对话，不是磁盘。** 文件改动由 `/undo` 负责，两者刻意分开：
 * 退回一句话很轻，退回一批文件改动是有风险的操作，不该被同一个手势
 * （连按两下 Esc）同时触发。回溯后会明确告诉用户这一点。
 */

/**
 * 一轮 = 从一条 user 消息起，到下一条 user 消息之前的全部内容。
 * 中间的 assistant 回复与工具调用都属于这一轮。
 */
function lastTurnStart(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && !isSyntheticUserMessage(messages[i])) return i
  }
  return -1
}

/**
 * 有两类消息挂着 user 角色，却不是用户说的话：
 *
 * - **压缩摘要**（`<compaction-summary>`）：把它当轮次起点，一次回溯会把
 *   整段被压缩的历史一起丢掉。
 * - **工具结果**（`tool_result` 块）：协议要求它以 user 角色回传。把它当
 *   起点的话，回溯只会退掉「工具结果 + 之后的回复」，用户真正问的那句和
 *   中间的工具调用留在原地 —— 退了半轮，比不退更糟。
 */
function isSyntheticUserMessage(message) {
  const content = message?.content
  if (typeof content === "string") return content.startsWith("<compaction-summary")
  if (!Array.isArray(content)) return false
  // 只含工具结果的消息是协议噪音；混有真实文本的才算用户输入
  return content.length > 0 && content.every((block) => block?.type === "tool_result")
}

/**
 * 回溯最近一轮。
 *
 * @param {string} sessionId
 * @param {{deps?: object}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, removed: number, prompt: string}>}
 *   `prompt` 是被撤回的那句用户输入 —— 调用方可以把它填回输入框，
 *   让「退回去改一下再问」变成一步而不是两步。
 */
export async function rewindLastTurn(sessionId, { deps = {} } = {}) {
  const history = deps.getConversationHistory || getConversationHistory
  const replace = deps.replaceMessages || replaceMessages

  const messages = await history(sessionId, 9999)
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: "empty_session", removed: 0, prompt: "" }
  }

  const start = lastTurnStart(messages)
  if (start < 0) {
    return { ok: false, reason: "nothing_to_rewind", removed: 0, prompt: "" }
  }

  const removed = messages.slice(start)
  const kept = messages.slice(0, start)
  await replace(sessionId, kept)

  return {
    ok: true,
    removed: removed.length,
    prompt: extractText(removed[0]),
    keptCount: kept.length
  }
}

/** 从消息内容里取出可读文本 —— content 可能是字符串，也可能是块数组 */
function extractText(message) {
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n")
    .trim()
}

/**
 * 会话里还有多少可回溯的轮次 —— 用于在没得可退时给出诚实的提示，
 * 而不是让 Esc 静默地什么也不做。
 */
export async function countRewindableTurns(sessionId, { deps = {} } = {}) {
  const history = deps.getConversationHistory || getConversationHistory
  const messages = await history(sessionId, 9999)
  if (!Array.isArray(messages)) return 0
  return messages.filter((m) => m?.role === "user" && !isSyntheticUserMessage(m)).length
}
