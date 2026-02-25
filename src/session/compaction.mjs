import { requestProvider } from "../provider/router.mjs"
import { getConversationHistory, replaceMessages } from "./store.mjs"
import { HookBus } from "../plugin/hook-bus.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { recordTurn } from "../usage/usage-meter.mjs"
import { loadPricing, calculateCost } from "../usage/pricing.mjs"

const COMPACTION_SYSTEM = `You are a conversation summarizer. Create a structured summary preserving all critical information for continued work.

## Output Format

<summary>
<goal>The user's overall goal or current task</goal>
<completed>
- Completed task with specific details (file paths, function names, line numbers)
</completed>
<in_progress>Current work being done, if any</in_progress>
<files_modified>
- path/to/file: specific change description
</files_modified>
<key_decisions>
- Decision and reasoning
- User preferences or constraints
</key_decisions>
<errors_resolved>
- Error description → fix applied
</errors_resolved>
<next_steps>
- Specific next action items
</next_steps>
</summary>

Rules:
- Use the SAME LANGUAGE as the conversation
- Preserve ALL file paths, function names, variable names, and technical identifiers exactly
- Include specific code changes, not just "modified file X"
- Omit tool call metadata and message formatting details
- Be concise but never drop actionable information`

const DEFAULT_THRESHOLD_MESSAGES = 50
const DEFAULT_THRESHOLD_RATIO = 0.7
const DEFAULT_KEEP_RECENT = 6
const TOOL_RESULT_PREVIEW_LIMIT = 200

// Estimate tokens from a string, accounting for CJK characters (~1.5 chars/token vs ~4 for Latin)
export function estimateStringTokens(str) {
  if (!str) return 0
  let cjk = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF)) cjk++
  }
  const latin = str.length - cjk
  return Math.ceil(latin / 4 + cjk / 1.5)
}

const MSG_OVERHEAD = 4 // ~4 tokens per message for role/metadata

export function estimateTokenCount(messages) {
  let tokens = 0
  for (const msg of messages) {
    tokens += MSG_OVERHEAD
    const content = msg.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "image") {
          tokens += 1600 // conservative estimate for a typical image
        } else if (block.type === "tool_use") {
          tokens += estimateStringTokens(block.name || "")
          tokens += estimateStringTokens(JSON.stringify(block.input || {}))
        } else if (block.type === "tool_result") {
          tokens += estimateStringTokens(String(block.content || ""))
        } else {
          tokens += estimateStringTokens(block.text || block.content || "")
        }
      }
    } else {
      tokens += estimateStringTokens(content || "")
    }
  }
  return tokens
}

/**
 * Pre-prune messages before LLM summarization.
 * - Strip synthetic scaffolding messages (continuation noise)
 * - Truncate large tool_result content with aging: older steps get shorter previews
 * - Keep tool_use blocks intact (they show model intent)
 * - Truncate very long plain-text assistant/user messages
 */
export function pruneForSummary(messages, previewLimit = TOOL_RESULT_PREVIEW_LIMIT) {
  // Strip synthetic scaffolding messages (continuation prompts, fake tool_result errors)
  const real = messages.filter(msg => !msg.synthetic)

  // #2 工具结果老化: find max step to compute relative age per message
  const maxStep = real.reduce((m, msg) => Math.max(m, msg.step || 0), 0)

  return real.map((msg) => {
    // Aging: older tool_results get more aggressive truncation
    const age = maxStep - (msg.step || 0)
    const effectiveLimit = Math.max(50, previewLimit - age * 15)

    const content = msg.content
    if (Array.isArray(content)) {
      const pruned = content.map((block) => {
        if (block.type === "tool_result") {
          const raw = String(block.content || "")
          if (raw.length > effectiveLimit) {
            return {
              ...block,
              content: `${raw.slice(0, effectiveLimit)}... [truncated ${raw.length} chars, age=${age}]`
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

const BUILTIN_CONTEXT = {
  "gpt-5": 272000, "o3": 200000, "o1": 200000,
  "claude-opus-4": 200000, "claude-3-5": 200000, "claude-3.5": 200000, "claude": 200000,
  "gemini-2": 1048576, "gemini-1.5": 1048576, "gemini": 128000,
  "gpt-4o": 128000, "gpt-4": 128000, "gpt-3.5": 16000,
  "deepseek": 64000, "qwen": 128000
}

export function modelContextLimit(model, configState = null) {
  const m = String(model || "").toLowerCase()
  // 1) Check provider-level context_limit for the active provider
  const providerCfg = configState?.config?.provider
  if (providerCfg) {
    // Per-model override from provider.model_context map
    const mc = providerCfg.model_context
    if (mc) {
      if (mc[model]) return mc[model]
      for (const key of Object.keys(mc)) {
        if (m.startsWith(key.toLowerCase())) return mc[key]
      }
    }
    // Provider-level context_limit
    const active = providerCfg[providerCfg.default]
    if (active?.context_limit > 0) return active.context_limit
  }
  // 2) Builtin prefix match
  for (const [prefix, limit] of Object.entries(BUILTIN_CONTEXT)) {
    if (m.includes(prefix)) return limit
  }
  return 128000
}

export function contextUtilization(messages, model, configState = null) {
  const tokens = estimateTokenCount(messages)
  const limit = modelContextLimit(model, configState)
  const ratio = limit > 0 ? Math.min(1, tokens / limit) : 0
  return {
    tokens,
    limit,
    ratio,
    percent: Math.round(ratio * 100)
  }
}

export function supportsNativeCompaction(providerType, model) {
  if (providerType !== "anthropic") return false
  const m = String(model || "").toLowerCase()
  return m.includes("claude") && (m.includes("opus") || m.includes("sonnet"))
}

export function shouldCompact({ messages, model, thresholdMessages = DEFAULT_THRESHOLD_MESSAGES, thresholdRatio = DEFAULT_THRESHOLD_RATIO, configState = null, realTokenCount = null }) {
  if (messages.length >= thresholdMessages) return true
  const limit = modelContextLimit(model, configState)
  const tokens = realTokenCount != null ? realTokenCount : estimateTokenCount(messages)
  return tokens >= limit * thresholdRatio
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

  // Find split point that doesn't break tool_use/tool_result pairs
  let splitIdx = history.length - keepRecent
  while (splitIdx > 0 && splitIdx < history.length) {
    const msg = history[splitIdx]
    const content = msg.content
    if (Array.isArray(content) && content.some(b => b.type === "tool_result")) {
      splitIdx-- // include the paired assistant tool_use message
      continue
    }
    break
  }
  const toSummarize = history.slice(0, splitIdx)
  const kept = history.slice(splitIdx)

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
  let compactionUsage = null
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
    compactionUsage = response.usage || null
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

  // Record compaction LLM usage so it's not "invisible"
  if (compactionUsage) {
    try {
      const { pricing } = await loadPricing(configState)
      const { amount } = calculateCost(pricing, model, compactionUsage)
      await recordTurn({ sessionId, usage: compactionUsage, cost: amount })
    } catch { /* best-effort */ }
  }

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
