import { requestProvider } from "../provider/router.mjs"
import { getConversationHistory, replaceMessages } from "./store.mjs"
import { HookBus } from "../plugin/hook-bus.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"

const COMPACTION_SYSTEM = `You are a conversation summarizer. Your task is to create a concise summary of the conversation so far to reduce context size while preserving critical information.

Focus on:
- What tasks were completed and what is currently being worked on
- Which files were created, modified, or deleted
- Key decisions made and user preferences expressed
- What needs to be done next
- Any errors encountered and how they were resolved

Output a single summary in the same language as the conversation. Do NOT include tool call details or message metadata. Be concise but complete.`

const DEFAULT_THRESHOLD_MESSAGES = 50
const DEFAULT_THRESHOLD_RATIO = 0.7
const DEFAULT_KEEP_RECENT = 6
const TOOL_RESULT_PREVIEW_LIMIT = 200

export function estimateTokenCount(messages) {
  let chars = 0
  for (const msg of messages) {
    const content = msg.content
    if (Array.isArray(content)) {
      for (const block of content) {
        chars += (block.text || block.content || "").length
      }
    } else {
      chars += (content || "").length
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Pre-prune messages before LLM summarization.
 * - Truncate large tool_result content to a short preview
 * - Keep tool_use blocks intact (they show model intent)
 * - Truncate very long plain-text assistant/user messages
 */
export function pruneForSummary(messages, previewLimit = TOOL_RESULT_PREVIEW_LIMIT) {
  return messages.map((msg) => {
    const content = msg.content
    if (Array.isArray(content)) {
      const pruned = content.map((block) => {
        if (block.type === "tool_result") {
          const raw = String(block.content || "")
          if (raw.length > previewLimit) {
            return {
              ...block,
              content: `${raw.slice(0, previewLimit)}... [truncated ${raw.length} chars]`
            }
          }
        }
        return block
      })
      return { ...msg, content: pruned }
    }
    // Truncate very long plain-text messages (e.g. large tool output pasted as text)
    if (typeof content === "string" && content.length > 2000) {
      return { ...msg, content: `${content.slice(0, 2000)}... [truncated ${content.length} chars]` }
    }
    return msg
  })
}

export function modelContextLimit(model) {
  const m = String(model || "").toLowerCase()
  if (m.includes("gpt-5")) return 272000
  if (m.includes("claude-opus-4")) return 200000
  if (m.includes("claude-3-5") || m.includes("claude-3.5")) return 200000
  if (m.includes("claude")) return 200000
  if (m.includes("gpt-4o")) return 128000
  if (m.includes("gpt-4")) return 128000
  if (m.includes("gpt-3.5")) return 16000
  if (m.includes("deepseek")) return 64000
  if (m.includes("qwen")) return 128000
  return 128000
}

export function contextUtilization(messages, model) {
  const tokens = estimateTokenCount(messages)
  const limit = modelContextLimit(model)
  const ratio = limit > 0 ? Math.min(1, tokens / limit) : 0
  return {
    tokens,
    limit,
    ratio,
    percent: Math.round(ratio * 100)
  }
}

export function shouldCompact({ messages, model, thresholdMessages = DEFAULT_THRESHOLD_MESSAGES, thresholdRatio = DEFAULT_THRESHOLD_RATIO }) {
  if (messages.length >= thresholdMessages) return true
  const utilization = contextUtilization(messages, model)
  return utilization.tokens >= utilization.limit * thresholdRatio
}

export async function compactSession({
  sessionId,
  model,
  providerType,
  configState,
  keepRecent = DEFAULT_KEEP_RECENT,
  baseUrl = null,
  apiKeyEnv = null
}) {
  const history = await getConversationHistory(sessionId, 9999)
  if (history.length <= keepRecent + 2) return { compacted: false, reason: "too few messages" }

  const toSummarize = history.slice(0, -keepRecent)
  const kept = history.slice(-keepRecent)

  // Layer 1: prune large tool outputs before sending to LLM
  const pruned = pruneForSummary(toSummarize)
  const summaryPrompt = pruned.map((m) => {
    const content = m.content
    if (Array.isArray(content)) {
      return `[${m.role}]: ${content.map((b) => {
        if (b.type === "text") return b.text || ""
        if (b.type === "tool_use") return `[tool_use:${b.name}(${JSON.stringify(b.input || {}).slice(0, 120)})]`
        if (b.type === "tool_result") return `[tool_result:${b.is_error ? "ERROR " : ""}${b.content || ""}]`
        return ""
      }).filter(Boolean).join("\n")}`
    }
    return `[${m.role}]: ${content}`
  }).join("\n\n")

  const hookPayload = await HookBus.sessionCompacting({
    sessionId,
    messageCount: history.length,
    summarizeCount: toSummarize.length,
    keepCount: kept.length
  })
  if (hookPayload?.skip) return { compacted: false, reason: "skipped by hook" }

  let summaryText
  try {
    const response = await requestProvider({
      configState,
      providerType,
      model,
      system: COMPACTION_SYSTEM,
      messages: [{ role: "user", content: summaryPrompt }],
      tools: [],
      baseUrl,
      apiKeyEnv
    })
    summaryText = (response.text || "").trim()
  } catch (error) {
    return { compacted: false, reason: `compaction LLM call failed: ${error.message}` }
  }

  if (!summaryText) return { compacted: false, reason: "empty summary from LLM" }

  // Replace all messages with: [summary] + [kept recent messages]
  const summaryMessage = {
    role: "user",
    content: `<compaction-summary>\n${summaryText}\n</compaction-summary>`
  }
  await replaceMessages(sessionId, [summaryMessage, ...kept])

  await saveCheckpoint(sessionId, {
    kind: "compaction",
    iteration: 0,
    compactedAt: Date.now(),
    summarizeCount: toSummarize.length,
    keepCount: kept.length,
    summaryVersion: 1,
    summaryLength: summaryText.length
  })

  return {
    compacted: true,
    summarizedCount: toSummarize.length,
    keptCount: kept.length,
    summaryLength: summaryText.length
  }
}
