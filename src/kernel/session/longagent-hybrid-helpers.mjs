import { processTurnLoop } from "./loop.mjs"
import { parseJsonLoose } from "./longagent-utils.mjs"
import { validateAndNormalizeStagePlan, defaultStagePlan } from "./longagent-plan.mjs"

/**
 * Ultra 编排的辅助函数。
 *
 * 从 longagent-hybrid.mjs 抽出来的第一批：全部是自包含的纯函数（外加一个
 * 只依赖 processTurnLoop 的上下文压缩），与那个 2000 行的编排主体没有共享
 * 状态，所以搬家零风险且立刻可单测。
 *
 * 编排主体本身要拆，得先把它闭包里几十个 let 收进一个 run context —— 那是
 * 一次独立的手术，塞进本版本只会把风险压到 Ultra 主链路上，留作后续。
 */

// Checkpoint 结构校验
export function validateCheckpoint(cp) {
  if (!cp || !cp.stagePlan || !Array.isArray(cp.stagePlan.stages)) return false
  if (typeof cp.stageIndex !== "number" || cp.stageIndex < 0) return false
  if (cp.stageIndex > cp.stagePlan.stages.length) return false
  // Verify the previous stage exists for task checkpoint loading
  if (cp.stageIndex > 0 && !cp.stagePlan.stages[cp.stageIndex - 1]) return false
  return true
}

// Gate 修复策略路由 (Phase 8)
export function getGateFixStrategy(failures) {
  const gateTypes = (failures || []).map(f => f.gate).filter(Boolean)
  if (gateTypes.includes("test")) return { agent: "debugging-agent", prefix: "Analyze test failures and fix:" }
  if (gateTypes.every(g => g === "build")) return { agent: "coding-agent", prefix: "Fix build errors:" }
  if (gateTypes.every(g => g === "lint")) return { autoFix: "npx eslint --fix .", agent: "coding-agent", prefix: "Fix lint errors:" }
  return { agent: "coding-agent", prefix: "Fix gate failures:" }
}

// #13 上下文压缩
export async function compressContext(text, limit, { model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, toolContext }) {
  if (text.length <= limit) return text
  const out = await processTurnLoop({
    prompt: [
      `Compress the following engineering context to max ${Math.round(limit * 0.6)} characters.`,
      "Preserve ONLY:",
      "- Concrete decisions made (technology choices, architecture patterns, API contracts)",
      "- File paths and function signatures that were created or modified",
      "- Error messages and their resolutions",
      "- Cross-task dependencies and integration points",
      "- Test results (pass/fail with specific failure reasons)",
      "Discard: exploration logs, verbose tool output, repeated information, reasoning chains.",
      "Output the compressed context directly — no preamble or explanation.",
      "",
      text.slice(0, limit * 2)
    ].join("\n"),
    mode: "assistant", model, providerType, sessionId, configState, baseUrl, apiKeyEnv, signal, allowQuestion: false, toolContext
  })
  return (out.reply || text.slice(0, limit)).slice(0, limit)
}

// #3 动态计划修订解析
export function parseReplanMarker(text) {
  const match = String(text || "").match(/\[REPLAN:\s*([\s\S]*?)\]/i)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

// #1 细粒度回滚：从 debugging 输出中提取失败的 taskId
export function extractFailedTaskIds(text) {
  const ids = []
  const pattern = /\[FAILED_TASK:\s*(\S+)\]/gi
  let m
  while ((m = pattern.exec(text)) !== null) ids.push(m[1])
  return ids
}

export function buildConflictResolutionPrompt(conflictFiles) {
  return [
    "## Git Merge Conflict Resolution",
    "",
    "The following files have merge conflicts that must be resolved:",
    ...conflictFiles.map(f => `- ${f}`),
    "",
    "## Resolution Protocol",
    "1. Read each conflicted file and locate ALL conflict markers (<<<<<<< ======= >>>>>>>)",
    "2. For each conflict block:",
    "   - Understand what BOTH sides intended (ours = feature branch, theirs = base branch)",
    "   - Keep the feature branch changes (our work) unless they break base branch functionality",
    "   - If both sides modified the same logic, merge them intelligently (not just pick one)",
    "   - Remove ALL conflict markers — no <<<<<<< or ======= or >>>>>>> should remain",
    "3. After resolving, run syntax check on each file (node --check / python -m py_compile)",
    "4. Verify imports still resolve correctly across resolved files"
  ].join("\n")
}


export function parseBlueprintOutput(reply, objective, defaults) {
  const parseErrors = []

  // 1. 尝试提取 ```stage_plan_json ... ``` 块
  const jsonMatch = reply.match(/```stage_plan_json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    const parsed = parseJsonLoose(jsonMatch[1])
    if (parsed?.stages) {
      const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
      if (!errors.length) {
        return { architectureText: reply.replace(/```stage_plan_json[\s\S]*?```/g, "").trim(), stagePlan: plan, parseErrors: [] }
      }
      parseErrors.push(`stage_plan_json block validation: ${errors.join("; ")}`)
    } else {
      parseErrors.push("stage_plan_json block found but no stages field")
    }
  }

  // 2. 回退：尝试任意 JSON 围栏块（排除已处理的 stage_plan_json）
  const anyJson = reply.match(/```(?:json)?\s*([\s\S]*?)```/g)
  if (anyJson) {
    for (const block of anyJson) {
      if (/```stage_plan_json/.test(block)) continue
      const inner = block.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()
      const parsed = parseJsonLoose(inner)
      if (parsed?.stages) {
        const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
        if (!errors.length) return { architectureText: reply, stagePlan: plan, parseErrors: [] }
        parseErrors.push(`json block validation: ${errors.join("; ")}`)
      }
    }
  }

  // 3. 回退：裸 JSON — 定位含 "stages" 的最外层 {} 块
  const stripped = reply.replace(/```[\s\S]*?```/g, "")
  let braceDepth = 0, objStart = -1
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "{") { if (braceDepth === 0) objStart = i; braceDepth++ }
    else if (stripped[i] === "}") {
      braceDepth--
      if (braceDepth === 0 && objStart >= 0) {
        const candidate = stripped.slice(objStart, i + 1)
        if (candidate.includes('"stages"')) {
          const parsed = parseJsonLoose(candidate)
          if (parsed?.stages) {
            const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
            if (!errors.length) return { architectureText: reply, stagePlan: plan, parseErrors: [] }
            parseErrors.push(`bare JSON validation: ${errors.join("; ")}`)
          }
        }
        objStart = -1
      }
    }
  }

  // 4. 回退：YAML 围栏块（```yaml ... ```）
  const yamlBlocks = reply.match(/```ya?ml\s*([\s\S]*?)```/g)
  if (yamlBlocks) {
    for (const block of yamlBlocks) {
      const inner = block.replace(/```ya?ml?\s*/g, "").replace(/```/g, "").trim()
      try {
        const parsed = YAML.parse(inner)
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) continue
        if (parsed?.stages) {
          const { plan, errors } = validateAndNormalizeStagePlan(parsed, { objective, defaults })
          if (!errors.length) return { architectureText: reply, stagePlan: plan, parseErrors: [] }
          parseErrors.push(`yaml block validation: ${errors.join("; ")}`)
        }
      } catch (e) {
        parseErrors.push(`yaml parse error: ${e.message}`)
      }
    }
  }

  // 5. 最终回退：单任务默认计划
  if (!parseErrors.length) parseErrors.push("no JSON/YAML with stages field found in reply")
  return { architectureText: reply, stagePlan: defaultStagePlan(objective, defaults), parseErrors }
}
