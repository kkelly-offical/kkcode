const PATH_HINT_RE = /([./~][^\s"'`]+|\b[\w-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|yaml|yml|toml|txt|log|sh)\b)/gi
const INLINE_COMMAND_RE = /`([^`\n]+)`/g
const CONTINUATION_HINT_RE = /\b(continue|follow-?up|same task|same transaction|继续|补充|接着|顺便)\b/i

function uniqueLimited(values = [], limit = 4) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const normalized = String(value || "").trim().replace(/[),.;:]+$/g, "")
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= limit) break
  }
  return out
}

function normalizeObjective(prompt) {
  return String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220)
}

function inferPendingNextStep({ paths = [], commands = [] }) {
  if (commands.length) return `Continue the interrupted local command/verification step around \`${commands[0]}\`.`
  if (paths.length) return `Continue the interrupted local task around ${paths[0]}.`
  return "Continue the interrupted bounded local task and finish the next concrete step."
}

export function extractPromptPathHints(prompt) {
  return uniqueLimited(Array.from(String(prompt || "").matchAll(PATH_HINT_RE), (match) => match[1]), 6)
}

export function detectAgentContinuationInput(prompt, summary = null) {
  const text = String(prompt || "").trim()
  if (!text) return false
  if (CONTINUATION_HINT_RE.test(text)) return true
  const objective = String(summary?.objective || summary?.prompt || "").trim()
  if (objective && text.includes(objective.slice(0, Math.min(objective.length, 40)))) return true
  return false
}

export function summarizeAgentTransaction({ prompt, route = null, mode = "agent" }) {
  const text = String(prompt || "").trim()
  const paths = extractPromptPathHints(text)
  const commands = uniqueLimited(Array.from(text.matchAll(INLINE_COMMAND_RE), (match) => match[1]))
  const evidence = Array.isArray(route?.evidence) ? route.evidence : []
  const objective = normalizeObjective(text)

  return {
    mode,
    prompt: text,
    objective,
    paths,
    commands,
    routeReason: route?.reason || null,
    routeExplanation: route?.explanation || null,
    evidence,
    pendingNextStep: inferPendingNextStep({ paths, commands })
  }
}

export function buildAgentContinuationPrompt(summary, continuation) {
  const nextMessage = String(continuation || "").trim()
  if (!summary?.prompt) return nextMessage

  const lines = [
    summary.prompt,
    "",
    "[Interrupted agent transaction]",
    `Objective: ${summary.objective || summary.prompt}`,
    summary.paths?.length ? `Paths: ${summary.paths.join(", ")}` : null,
    summary.commands?.length ? `Commands: ${summary.commands.join(" | ")}` : null,
    summary.routeReason ? `Last route reason: ${summary.routeReason}` : null,
    summary.routeExplanation ? `Route explanation: ${summary.routeExplanation}` : null,
    summary.evidence?.length ? `Evidence categories: ${summary.evidence.join(", ")}` : null,
    summary.pendingNextStep ? `Pending next step: ${summary.pendingNextStep}` : null,
    "Instruction: Treat the next user message as a continuation of the same bounded local agent transaction unless it clearly introduces a heavier multi-file or staged objective.",
    "",
    "[User continuation]",
    nextMessage
  ]

  return lines.filter(Boolean).join("\n")
}
