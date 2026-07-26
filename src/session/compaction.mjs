import { requestProvider } from "../provider/router.mjs"
import { getConversationHistory, replaceMessages } from "./store.mjs"
import { HookBus } from "../plugin/hook-bus.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { recordTurn } from "../usage/usage-meter.mjs"
import { loadPricing, calculateCost } from "../usage/pricing.mjs"

const COMPACTION_SYSTEM = `You are a conversation summarizer. Create a structured, merge-safe summary preserving all critical information for continued work.

## Output Format

Return exactly:

<context-state>
{
  "goal": "The user's current overall goal",
  "completed": ["Completed work with specific file paths, function names, and line numbers"],
  "in_progress": ["Current work being done"],
  "files_modified": [{"path":"path/to/file","changes":["specific change"]}],
  "key_decisions": ["Decision, constraint, or user preference"],
  "errors_resolved": ["Error -> fix applied"],
  "evidence": ["Important command output, test result, provider error, or exact failure detail"],
  "next_steps": ["Specific next action item"]
}
</context-state>

<summary>
Concise human-readable continuation summary.
</summary>

Rules:
- Use the SAME LANGUAGE as the conversation
- Merge the prior context state with the new conversation delta; do not summarize the prior state as another chat message
- Preserve ALL file paths, function names, variable names, and technical identifiers exactly
- Include specific code changes, not just "modified file X"
- Omit tool call metadata and message formatting details
- Preserve exact errors, failing test names, package versions, release labels, and user constraints in evidence
- Be concise but never drop actionable information`

// 0.6.0 起自动压缩以「上下文占用 85%」为主判据。消息数不再是并列触发器
// —— 0.5.x 时它是 50 条 OR 起跳，长会话几乎总是消息数先撞线，把比例阈值
// 架空（调 ratio 根本不生效）。现在它是高位安全网：即使 token 估算说还早，
// 超长历史本身也会拖垮 provider 与检索质量，所以保留一个宽松的绝对上限。
const DEFAULT_THRESHOLD_MESSAGES = 200
const DEFAULT_THRESHOLD_RATIO = 0.85
const DEFAULT_KEEP_RECENT = 6
const DEFAULT_KEEP_RECENT_TURNS = 3
const TOOL_RESULT_PREVIEW_LIMIT = 200
const EVIDENCE_PREVIEW_LIMIT = 900
const PATH_RE = /(?:^|\s)([A-Za-z0-9_.@~/-]+\.(?:mjs|js|ts|tsx|jsx|json|yaml|yml|md|txt|rs|go|py|sh|toml|lock))(?:[:\s]|$)/g
const IMPORTANT_LINE_RE = /(error|failed|failure|exception|traceback|assert|reject|denied|unauthorized|context|compact|version|publish|npm|test|lint|typecheck|diff|modified)/i

export function isCompactionSummaryMessage(msg) {
  const content = msg?.content
  if (typeof content === "string") return content.includes("<compaction-summary")
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (typeof block === "string") return block.includes("<compaction-summary")
      return block?.type === "text" && typeof block.text === "string" && block.text.includes("<compaction-summary")
    })
  }
  return false
}

export function extractCompactionSummary(content) {
  const text = Array.isArray(content)
    ? content.map((block) => typeof block === "string" ? block : (block?.text || block?.content || "")).join("\n")
    : String(content || "")
  const match = text.match(/<compaction-summary(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/compaction-summary>/i)
  return (match ? match[1] : "").trim()
}

function clip(text, limit = EVIDENCE_PREVIEW_LIMIT) {
  const raw = String(text || "")
  if (raw.length <= limit) return raw
  return raw.slice(0, limit) + "... [truncated " + raw.length + " chars]"
}

function extractPaths(text) {
  const paths = new Set()
  let match
  PATH_RE.lastIndex = 0
  while ((match = PATH_RE.exec(String(text || ""))) !== null) {
    paths.add(match[1])
    if (paths.size >= 12) break
  }
  return [...paths]
}

function importantLines(text, limit = 12) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && IMPORTANT_LINE_RE.test(line))
    .slice(0, limit)
}

export function collectEvidenceLedger(messages, previewLimit = EVIDENCE_PREVIEW_LIMIT) {
  const evidence = []
  for (const msg of messages) {
    const content = msg.content
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }]
    for (const block of blocks) {
      const raw = String(block?.content || block?.text || "")
      if (!raw) continue
      if (block.type === "tool_result") {
        const lines = importantLines(raw)
        const paths = extractPaths(raw)
        if (block.is_error || lines.length || paths.length) {
          evidence.push([
            "- role=" + msg.role + " tool_result" + (block.is_error ? " ERROR" : ""),
            paths.length ? "  paths: " + paths.join(", ") : "",
            lines.length ? "  key_lines:\n" + lines.map((line) => "    " + clip(line, 220)).join("\n") : "  preview: " + clip(raw, previewLimit)
          ].filter(Boolean).join("\n"))
        }
      } else if (typeof content === "string" && raw.length > 1000) {
        const lines = importantLines(raw)
        const paths = extractPaths(raw)
        if (lines.length || paths.length) {
          evidence.push([
            "- role=" + msg.role + " long_text",
            paths.length ? "  paths: " + paths.join(", ") : "",
            lines.length ? "  key_lines:\n" + lines.map((line) => "    " + clip(line, 220)).join("\n") : ""
          ].filter(Boolean).join("\n"))
        }
      }
      if (evidence.length >= 20) return evidence
    }
  }
  return evidence
}

export function buildCompactionPrompt({ previousSummary = "", messages, evidence = [] }) {
  const transcript = messages.map((m) => {
    const content = m.content
    if (Array.isArray(content)) {
      return "[" + m.role + "]: " + content.map((b) => {
        if (b.type === "text") return b.text || ""
        if (b.type === "tool_use") return "[tool_use:" + b.name + "(" + JSON.stringify(b.input || {}).slice(0, 120) + ")]"
        if (b.type === "tool_result") return "[tool_result:" + (b.is_error ? "ERROR " : "") + (b.content || "") + "]"
        return ""
      }).filter(Boolean).join("\n")
    }
    return "[" + m.role + "]: " + content
  }).join("\n\n")

  return [
    "<prior-context-state>",
    previousSummary || "No prior compacted context.",
    "</prior-context-state>",
    "",
    "<evidence-ledger>",
    evidence.length ? evidence.join("\n") : "No extracted evidence ledger.",
    "</evidence-ledger>",
    "",
    "<conversation-delta>",
    transcript,
    "</conversation-delta>"
  ].join("\n")
}

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

/**
 * 兜底的模型上下文表。优先级最低 —— provider.model_context 与目录发现
 * （applyDiscoveredContextLimits）都排在它前面。
 *
 * 前缀匹配，长前缀要写在短前缀之前（`Object.entries` 按声明序遍历，
 * `claude` 若排在 `claude-opus-4` 前面会把后者吃掉）。
 */
const BUILTIN_CONTEXT = {
  // kimi：k3 是 1M，coding 系列是 256K。此前整个 kimi 族缺失，
  // k3 走默认 128000 —— 少算了八倍，压缩因此提前触发。
  "k3-256k": 262144, "k3": 1048576,
  "kimi-for-coding": 262144, "kimi": 262144,
  "gpt-5": 272000, "o3": 200000, "o1": 200000,
  "claude-opus-4": 200000, "claude-sonnet-4": 200000,
  "claude-3-5": 200000, "claude-3.5": 200000, "claude": 200000,
  "gemini-2": 1048576, "gemini-1.5": 1048576, "gemini": 128000,
  "gpt-4o": 128000, "gpt-4": 128000, "gpt-3.5": 16000,
  "deepseek-r": 128000, "deepseek": 64000,
  "qwen3": 262144, "qwen": 128000,
  "glm-4": 128000, "glm": 128000
}

export function modelContextLimit(model, configState = null, providerType = "") {
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
    // Provider-level context_limit。必须用「本轮实际使用的 provider」——
    // /provider 切换只改 state.providerType 不改 config.provider.default，
    // 0.6.0 之前这里读 default，会话内切渠道后上限与状态栏百分比全部失准。
    const active = providerCfg[providerType || providerCfg.default]
    if (active?.context_limit > 0) return active.context_limit
  }
  // 2) Builtin prefix match
  for (const [prefix, limit] of Object.entries(BUILTIN_CONTEXT)) {
    if (m.includes(prefix)) return limit
  }
  return 128000
}

export function contextUtilization(messages, model, configState = null, providerType = "") {
  const tokens = estimateTokenCount(messages)
  const limit = modelContextLimit(model, configState, providerType)
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

export function shouldCompact({ messages, model, thresholdMessages = DEFAULT_THRESHOLD_MESSAGES, thresholdRatio = DEFAULT_THRESHOLD_RATIO, configState = null, providerType = "", realTokenCount = null }) {
  if (messages.length >= thresholdMessages) return true
  const limit = modelContextLimit(model, configState, providerType)
  const tokens = realTokenCount != null ? realTokenCount : estimateTokenCount(messages)
  return tokens >= limit * thresholdRatio
}

export async function compactSession({
  sessionId,
  turnId = null,
  model,
  providerType,
  configState,
  keepRecent = DEFAULT_KEEP_RECENT,
  keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS,
  baseUrl = null,
  apiKeyEnv = null,
  traceId = "",
  parentEventId = ""
}) {
  const history = await getConversationHistory(sessionId, 9999, { includeMetadata: true })
  if (history.length <= keepRecent + 2) return { compacted: false, reason: "too few messages" }
  const previousSummary = isCompactionSummaryMessage(history[0])
    ? extractCompactionSummary(history[0].content)
    : ""
  const workingHistory = previousSummary ? history.slice(1) : history

  // Turn-based split: keep last keepRecentTurns complete turns
  // A "turn" = one user interaction cycle (user msg + model response + all tool calls)
  // Falls back to message-count if no turnId metadata is present
  let splitIdx
  const turnIds = []
  const seenTurns = new Set()
  for (const msg of workingHistory) {
    if (msg.turnId && !seenTurns.has(msg.turnId)) {
      seenTurns.add(msg.turnId)
      turnIds.push(msg.turnId)
    }
  }
  if (turnIds.length > keepRecentTurns) {
    const keepFromTurnId = turnIds[turnIds.length - keepRecentTurns]
    splitIdx = workingHistory.findIndex(msg => msg.turnId === keepFromTurnId)
    if (splitIdx < 0) splitIdx = workingHistory.length - keepRecent
  } else {
    // Fallback: not enough turns, use message count
    splitIdx = workingHistory.length - keepRecent
  }
  const toSummarize = workingHistory.slice(0, splitIdx)
  const kept = workingHistory.slice(splitIdx)

  // Layer 1: extract exact evidence, then prune large tool outputs before sending to LLM
  const evidence = collectEvidenceLedger(toSummarize)
  const pruned = pruneForSummary(toSummarize)
  const summaryPrompt = buildCompactionPrompt({ previousSummary, messages: pruned, evidence })

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
      apiKeyEnv,
      traceId,
      parentEventId,
      sessionId,
      turnId
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
    content: `<compaction-summary version="2">\n${summaryText}\n</compaction-summary>`
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
    iteration: Date.now(),
    compactedAt: Date.now(),
    summarizeCount: toSummarize.length,
    keepCount: kept.length,
    summaryVersion: 2,
    summaryLength: summaryText.length,
    previousSummaryLength: previousSummary.length,
    evidenceCount: evidence.length
  })

  return {
    compacted: true,
    summarizedCount: toSummarize.length,
    keptCount: kept.length,
    summaryLength: summaryText.length
  }
}
