import { newId } from "../core/types.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { requestProviderStream } from "../provider/router.mjs"
import { ToolRegistry } from "../tool/registry.mjs"
import { executeTool } from "../tool/executor.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { createTaskDelegate } from "../orchestration/task-scheduler.mjs"
import { loadInstructions } from "./instruction-loader.mjs"
import { buildSystemPromptBlocks } from "./system-prompt.mjs"
import { detectProjectContext } from "./project-context.mjs"
import { renderRulesPrompt } from "../rules/load-rules.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import {
  touchSession,
  appendMessage,
  appendPart,
  getConversationHistory,
  markSessionStatus,
  updateSession
} from "./store.mjs"
import { pendingRejections, markRejectionsConsumed } from "../review/rejection-queue.mjs"
import { isRecoveryEnabled, markTurnFinished, markTurnInProgress } from "./recovery.mjs"
import { HookBus, initHookBus } from "../plugin/hook-bus.mjs"
import { shouldCompact, compactSession, estimateTokenCount, modelContextLimit, contextUtilization } from "./compaction.mjs"
import { createStreamRenderer } from "../theme/markdown.mjs"
import { paint } from "../theme/color.mjs"
import { saveCheckpoint } from "./checkpoint.mjs"
import { askPlanApproval } from "../tool/question-prompt.mjs"

const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "background_output", "todowrite", "enter_plan", "exit_plan"
])

function addUsage(target, delta) {
  target.input += delta.input || 0
  target.output += delta.output || 0
  target.cacheRead += delta.cacheRead || 0
  target.cacheWrite += delta.cacheWrite || 0
}


async function buildSystemPrompt({ mode, model, cwd, agent = null, tools = [], skills = [], language = "en" }) {
  // Assemble user instructions + rules (Layer 6)
  const instructions = await loadInstructions(cwd)
  const rules = await renderRulesPrompt(cwd)
  const userInstructions = [...instructions, rules].filter(Boolean).join("\n\n")

  // Detect project context (framework, language, build tool, etc.)
  const projectContext = await detectProjectContext(cwd)

  // Build structured blocks for provider-level cache optimization
  const result = await buildSystemPromptBlocks({ mode, model, cwd, agent, tools, skills, userInstructions, projectContext, language })
  return result
}

function toolPatternFromArgs(args) {
  if (!args || typeof args !== "object") return "*"
  return String(args.path || args.command || args.pattern || args.task_id || "*")
}

function normalizeMessageForCache(msg) {
  const content = msg?.content
  // For array content (image blocks, tool_use, tool_result), serialize to a stable string
  if (Array.isArray(content)) {
    const textParts = content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
    const imageParts = content
      .filter((b) => b.type === "image")
      .map((b) => `[image:${b.path || "inline"}]`)
      .join(" ")
    const toolUseParts = content
      .filter((b) => b.type === "tool_use")
      .map((b) => `[tool_use:${b.name}:${b.id}]`)
      .join(" ")
    const toolResultParts = content
      .filter((b) => b.type === "tool_result")
      .map((b) => `[tool_result:${b.tool_use_id}:${String(b.content || "").slice(0, 100)}]`)
      .join(" ")
    const extras = [imageParts, toolUseParts, toolResultParts].filter(Boolean).join("\n")
    return {
      role: String(msg?.role || ""),
      content: `${textParts}${extras ? "\n" + extras : ""}`
    }
  }
  return {
    role: String(msg?.role || ""),
    content: String(content || "")
  }
}

function isPrefixMessages(prefix, full) {
  if (!Array.isArray(prefix) || !Array.isArray(full)) return false
  if (prefix.length > full.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i].role !== full[i].role || prefix[i].content !== full[i].content) return false
  }
  return true
}

export async function processTurnLoop({
  prompt,
  contentBlocks = null,
  mode,
  model,
  providerType,
  sessionId,
  configState,
  baseUrl = null,
  apiKeyEnv = null,
  depth = 0,
  signal = null,
  output = null,
  subagent = null,
  agent = null,
  allowQuestion = true,
  toolContext = {}
}) {
  await initHookBus()

  if (depth > 8) {
    return {
      sessionId,
      turnId: newId("turn"),
      reply: "task delegation depth exceeded",
      emittedText: false,
      context: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolEvents: []
    }
  }

  const cwd = process.cwd()
  const turnId = newId("turn")
  const maxSteps = Math.max(1, Number(configState.config.agent.max_steps || 25))
  const verifyCompletion = configState.config.agent?.verify_completion !== false
  const recoveryEnabled = isRecoveryEnabled(configState.config)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolEvents = []
  const doomTracker = [] // recent tool call signatures for doom loop detection
  let emittedAnyText = false
  let lastContextMeter = null
  let contextCachePoint = null
  const thresholdRatio = Number(configState.config.session?.compaction_threshold_ratio ?? 0.7)
  const thresholdMessages = Number(configState.config.session?.compaction_threshold_messages ?? 50)
  const cachePointsEnabled = configState.config.session?.context_cache_points !== false

  await touchSession({
    sessionId,
    mode,
    model,
    providerType,
    cwd,
    status: "active",
    title: subagent ? `${subagent.name}: ${prompt.slice(0, 60)}` : null
  })

  await EventBus.emit({
    type: EVENT_TYPES.TURN_START,
    sessionId,
    turnId,
    payload: { mode, model, providerType, prompt }
  })

  const queue = await pendingRejections(cwd)
  const rejectionText = queue.length
    ? [
        "<review-rejections>",
        ...queue.map((entry, index) => `${index + 1}. file=${entry.file} reason=${entry.reason} risk=${entry.riskScore ?? "unknown"}`),
        "</review-rejections>",
        "Address these rejected changes before introducing new risky edits."
      ].join("\n")
    : ""
  const effectivePrompt = rejectionText ? `${prompt}\n\n${rejectionText}` : prompt

  // If contentBlocks provided (e.g. images), build array content for the message.
  // Prepend rejection text as a text block if needed.
  let messageContent
  if (contentBlocks && Array.isArray(contentBlocks)) {
    const blocks = [...contentBlocks]
    if (rejectionText) {
      // Find the first text block and prepend rejection text
      const textIdx = blocks.findIndex((b) => b.type === "text")
      if (textIdx >= 0) {
        blocks[textIdx] = { type: "text", text: `${blocks[textIdx].text}\n\n${rejectionText}` }
      } else {
        blocks.unshift({ type: "text", text: rejectionText })
      }
    }
    messageContent = blocks
  } else {
    messageContent = effectivePrompt
  }

  const userMessage = await appendMessage(sessionId, "user", messageContent, {
    mode,
    model,
    providerType,
    turnId
  })

  await appendPart(sessionId, {
    type: "turn-start",
    messageId: userMessage.id,
    turnId,
    mode,
    model,
    providerType
  })

  let systemTools = await ToolRegistry.list({ mode, config: configState.config, cwd })
  if (agent?.tools) {
    systemTools = systemTools.filter((t) => agent.tools.includes(t.name))
  }
  const skills = SkillRegistry.isReady() ? SkillRegistry.listForSystemPrompt() : []
  const language = configState.config.language || "en"
  const systemPrompt = await buildSystemPrompt({ mode, model, cwd, agent, tools: systemTools, skills, language })
  // systemPrompt = { text, blocks } — providers use blocks for cache optimization
  const delegateTask = createTaskDelegate({
    config: configState.config,
    parentSessionId: sessionId,
    model,
    providerType,
    runSubtask: async ({
      prompt: subPrompt,
      sessionId: subSessionId,
      model: subModel,
      providerType: subProvider,
      subagent: resolvedSubagent,
      allowQuestion: subAllowQuestion = false
    }) => {
      return processTurnLoop({
        prompt: subPrompt,
        mode: "agent",
        model: subModel,
        providerType: subProvider,
        sessionId: subSessionId,
        configState,
        baseUrl,
        apiKeyEnv,
        depth: depth + 1,
        signal,
        subagent: resolvedSubagent,
        allowQuestion: subAllowQuestion,
        toolContext
      })
    }
  })

  const MAX_CONTINUES = 3
  let continueCount = 0
  let nudgeCount = 0
  let finalReply = ""
  const sinkWrite = typeof output?.write === "function"
    ? output.write
    : () => {}
  try {
    for (let step = 1; step <= maxSteps; step++) {
      await markTurnInProgress(sessionId, turnId, step, recoveryEnabled)
      await EventBus.emit({
        type: EVENT_TYPES.TURN_STEP_START,
        sessionId,
        turnId,
        payload: { step }
      })

      let tools = await ToolRegistry.list({ mode, config: configState.config, cwd })
      if (agent?.tools) {
        tools = tools.filter((t) => agent.tools.includes(t.name))
      }
      let history = await getConversationHistory(sessionId, Number(configState.config.session.max_history || 30))

      const normalizedHistory = history.map(normalizeMessageForCache)
      let contextTokens = estimateTokenCount(normalizedHistory)
      let contextFromCache = false
      if (contextCachePoint && isPrefixMessages(contextCachePoint.messages, normalizedHistory)) {
        const delta = normalizedHistory.slice(contextCachePoint.messages.length)
        contextTokens = contextCachePoint.tokens + estimateTokenCount(delta)
        contextFromCache = true
      } else if (contextCachePoint) {
        contextCachePoint = null
      }
      const contextLimit = modelContextLimit(model)
      const contextRatio = contextLimit > 0 ? Math.min(1, contextTokens / contextLimit) : 0
      lastContextMeter = {
        tokens: contextTokens,
        limit: contextLimit,
        ratio: contextRatio,
        percent: Math.round(contextRatio * 100),
        fromCache: contextFromCache
      }

      if (cachePointsEnabled && (step === 1 || contextRatio >= thresholdRatio)) {
        contextCachePoint = {
          messages: normalizedHistory,
          tokens: contextTokens
        }
        await appendPart(sessionId, {
          type: "context-cache-point",
          turnId,
          step,
          tokenEstimate: contextTokens,
          contextLimit,
          contextRatio
        })
        await saveCheckpoint(sessionId, {
          kind: "context-cache-point",
          iteration: step,
          turnId,
          step,
          tokenEstimate: contextTokens,
          contextLimit,
          contextRatio,
          messageCount: normalizedHistory.length,
          fromCache: contextFromCache
        })
      }

      if (shouldCompact({
        messages: normalizedHistory,
        model,
        thresholdMessages,
        thresholdRatio
      })) {
          const compactResult = await compactSession({
            sessionId, model, providerType, configState, baseUrl, apiKeyEnv
          })
          if (compactResult.compacted) {
            await EventBus.emit({ type: EVENT_TYPES.SESSION_COMPACTED, sessionId, turnId, payload: compactResult })
            history = await getConversationHistory(sessionId, Number(configState.config.session.max_history || 30))
            const compactedMeter = contextUtilization(history.map(normalizeMessageForCache), model)
            lastContextMeter = { ...compactedMeter, fromCache: false }
            contextCachePoint = {
              messages: history.map(normalizeMessageForCache),
              tokens: compactedMeter.tokens
            }
          }
        }

      const messages = await HookBus.messagesTransform([...history])

      let response
      try {
        const chunks = requestProviderStream({
          configState,
          providerType,
          model,
          system: systemPrompt,
          messages,
          tools,
          baseUrl,
          apiKeyEnv,
          signal
        })
        const textParts = []
        const streamToolCalls = []
        let streamUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        let streamStopReason = "end_turn"
        const mdEnabled = configState.config.ui?.markdown_render !== false
        const streamRenderer = mdEnabled ? createStreamRenderer() : null
        let inThinking = false

        for await (const chunk of chunks) {
          if (chunk.type === "thinking") {
            if (!inThinking) {
              sinkWrite(paint("●", "#666666") + " " + paint("Thinking", null, { italic: true, dim: true }) + " " + paint("∨", null, { dim: true }) + "\n")
              inThinking = true
            }
            sinkWrite(paint("  " + chunk.content, null, { dim: true, italic: true }))
          } else if (chunk.type === "text") {
            if (inThinking) {
              sinkWrite("\n")
              inThinking = false
            }
            if (streamRenderer) {
              const rendered = streamRenderer.push(chunk.content)
              if (rendered) sinkWrite(rendered)
            } else {
              sinkWrite(chunk.content)
            }
            textParts.push(chunk.content)
          } else if (chunk.type === "tool_call") {
            if (inThinking) {
              sinkWrite("\n")
              inThinking = false
            }
            streamToolCalls.push(chunk.call)
          } else if (chunk.type === "usage") {
            streamUsage = chunk.usage
          } else if (chunk.type === "stop") {
            streamStopReason = chunk.reason || "end_turn"
          }
        }
        if (inThinking) {
          sinkWrite("\n")
        }
        if (streamRenderer) {
          const tail = streamRenderer.flush()
          if (tail) sinkWrite(tail)
        }
        if (textParts.length) {
          sinkWrite("\n")
          emittedAnyText = true
        }

        response = {
          text: textParts.join(""),
          toolCalls: streamToolCalls,
          usage: streamUsage,
          stopReason: streamStopReason
        }
      } catch (error) {
        if (error.needsCompaction) {
          const compactResult = await compactSession({
            sessionId, model, providerType, configState, baseUrl, apiKeyEnv
          })
          if (compactResult.compacted) {
            await EventBus.emit({ type: EVENT_TYPES.SESSION_COMPACTED, sessionId, turnId, payload: compactResult })
            continue
          }
        }
        await appendPart(sessionId, {
          type: "provider-error",
          messageId: userMessage.id,
          step,
          turnId,
          error: error.message,
          errorClass: error.errorClass || "unknown",
          needsCompaction: Boolean(error.needsCompaction)
        })
        throw error
      }

      addUsage(usage, response.usage || {})

      // Update context meter with real API total input tokens
      // Anthropic: input_tokens is only non-cached portion; total = input + cacheRead + cacheWrite
      // OpenAI: prompt_tokens is already the total
      const u = response.usage || {}
      const totalInput = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
      if (totalInput > 0) {
        const contextLimit = modelContextLimit(model)
        const contextRatio = contextLimit > 0 ? Math.min(1, totalInput / contextLimit) : 0
        lastContextMeter = {
          tokens: totalInput,
          limit: contextLimit,
          ratio: contextRatio,
          percent: Math.round(contextRatio * 100),
          fromCache: false,
          cacheRead: u.cacheRead || 0,
          cacheWrite: u.cacheWrite || 0,
          inputUncached: u.input || 0
        }
      }

      // Emit cumulative usage so status bar can update in real-time
      await EventBus.emit({
        type: EVENT_TYPES.TURN_USAGE_UPDATE,
        sessionId,
        turnId,
        payload: { usage: { ...usage }, step, model, context: lastContextMeter }
      })

      // --- Auto-continue on output truncation (max_tokens) ---
      if (response.stopReason === "max_tokens" && continueCount < MAX_CONTINUES) {
        continueCount++
        sinkWrite(paint(`\n  ↳ output truncated, auto-continuing (${continueCount}/${MAX_CONTINUES})...\n`, "yellow", { dim: true }))

        // Drop any tool calls with parse errors (truncated JSON from cutoff)
        const validToolCalls = (response.toolCalls || []).filter(tc => !tc.args?.__parse_error)

        // Save partial output as assistant message
        const partialContent = []
        if (response.text) {
          partialContent.push({ type: "text", text: response.text })
        }
        for (const call of validToolCalls) {
          partialContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.args || {} })
        }
        if (partialContent.length) {
          await appendMessage(sessionId, "assistant", partialContent.length === 1 && partialContent[0].type === "text"
            ? partialContent[0].text
            : partialContent, {
            mode, model, providerType, step, turnId, truncated: true
          })
        }

        // If there were valid tool calls, execute them and add results before continuing
        if (validToolCalls.length) {
          const resultContent = []
          for (const call of validToolCalls) {
            resultContent.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: "[truncated response — tool call acknowledged but output was cut off]",
              is_error: true
            })
          }
          await appendMessage(sessionId, "user", resultContent, {
            mode, model, providerType, step, turnId, synthetic: true
          })
        }

        // Inject continue prompt (localized)
        const continuePrompt = language === "zh"
          ? "[输出被截断] 你的上一条回复在输出 token 上限处被截断。请从你停止的地方精确继续，不要重复已经写过的内容。如果你正在执行工具调用，请完整重新发起。"
          : "[OUTPUT TRUNCATED] Your previous response was cut off at the output token limit. Continue EXACTLY from where you stopped. Do not repeat any content you already wrote. If you were in the middle of a tool call, re-issue it completely."
        await appendMessage(sessionId, "user", continuePrompt,
          { mode, model, providerType, step, turnId, synthetic: true }
        )

        // Don't consume a step for auto-continue
        step--
        continue
      }
      // Reset continue count on successful non-truncated response
      continueCount = 0

      if (!response.toolCalls?.length) {
        // Bug 8: nudge if todo items remain incomplete
        if (verifyCompletion && nudgeCount < 2) {
          const incomplete = (toolContext._todoState || []).filter(t => t.status !== "completed")
          if (incomplete.length > 0) {
            nudgeCount++
            const items = incomplete.map(t => `- ${t.content}`).join("\n")
            await appendMessage(sessionId, "user",
              `[TASK INCOMPLETE] You indicated completion, but these todo items remain unfinished:\n${items}\nPlease complete them or mark them as completed if done.`,
              { mode, model, providerType, step, turnId, synthetic: true }
            )
            continue
          }
        }
        finalReply = (response.text || "").trim() || "No content returned from provider."
        const assistant = await appendMessage(sessionId, "assistant", finalReply, {
          mode,
          model,
          providerType,
          step,
          turnId
        })
        await appendPart(sessionId, {
          type: "assistant-response",
          messageId: assistant.id,
          step,
          turnId,
          hasText: Boolean(finalReply)
        })
        await markSessionStatus(sessionId, "active")
        if (queue.length) {
          await markRejectionsConsumed(
            queue.map((entry) => entry.id),
            sessionId,
            cwd
          )
        }
        await markTurnFinished(sessionId, recoveryEnabled)
        await EventBus.emit({
          type: EVENT_TYPES.TURN_FINISH,
          sessionId,
          turnId,
          payload: { step, reply: finalReply }
        })
        return {
          sessionId,
          turnId,
          reply: finalReply,
          emittedText: emittedAnyText,
          context: lastContextMeter,
          usage,
          toolEvents
        }
      }

      // --- Execute tool calls (read-only in parallel, write tools serially) ---
      async function executeOneCall(call) {
        const runningPart = await appendPart(sessionId, {
          type: "tool-call",
          messageId: userMessage.id,
          step,
          turnId,
          tool: call.name,
          args: call.args,
          status: "running",
          output: ""
        })

        const pattern = toolPatternFromArgs(call.args)
        const command = call.name === "bash" ? String(call.args?.command || "") : ""
        const risk = ["bash", "write", "edit", "task"].includes(call.name) ? 9 : 1
        let result
        try {
          const hookTransformed = await HookBus.toolBefore({ tool: call.name, args: call.args, sessionId, step })
          if (hookTransformed?.args) call.args = hookTransformed.args

          if (call.name === "question" && !allowQuestion) {
            call.args = {
              ...(call.args || {}),
              _allowQuestion: false
            }
          }

          await PermissionEngine.check({
            config: configState.config,
            sessionId,
            tool: call.name,
            mode,
            pattern,
            command,
            risk,
            reason: `tool call from model at step ${step}`
          })

          const tool = await ToolRegistry.get(call.name)
          result = !tool
            ? {
                name: call.name,
                status: "error",
                output: `unknown tool: ${call.name}`,
                error: `unknown tool: ${call.name}`
              }
            : await executeTool({
                tool,
                args: call.args,
                sessionId,
                turnId,
                context: {
                  cwd,
                  mode,
                  delegateTask,
                  signal,
                  sessionId,
                  turnId,
                  config: configState.config,
                  ...toolContext
                },
                signal
              })
        } catch (error) {
          result = {
            name: call.name,
            status: "error",
            output: error.message,
            error: error.message
          }
        }

        const hookAfterResult = await HookBus.toolAfter({ tool: call.name, args: call.args, result, sessionId, step })
        if (hookAfterResult?.result) result = hookAfterResult.result

        // Plan approval interception: if the tool returned planApproval metadata,
        // pause and ask the user to approve/reject the plan
        if (result.metadata?.planApproval) {
          const approval = await askPlanApproval({
            plan: result.metadata.plan || "",
            files: result.metadata.files || []
          })
          result = {
            ...result,
            output: approval.approved
              ? "User APPROVED the plan. Proceed with implementation."
              : `User REJECTED the plan. Feedback: ${approval.feedback || "no feedback provided"}`,
            metadata: { ...result.metadata, planApprovalResult: approval }
          }
        }

        await appendPart(sessionId, {
          type: "tool-call",
          messageId: userMessage.id,
          step,
          turnId,
          runPartId: runningPart.id,
          tool: call.name,
          args: call.args,
          status: result.status,
          output: result.output
        })

        return { call, result }
      }

      // Split into read-only (parallelizable) and write (serial) groups
      const readOnlyCalls = []
      const writeCalls = []
      for (const call of response.toolCalls) {
        if (READ_ONLY_TOOLS.has(call.name)) {
          readOnlyCalls.push(call)
        } else {
          writeCalls.push(call)
        }
      }

      // Execute read-only tools in parallel
      const callResults = new Map() // call.id → { call, result }
      if (readOnlyCalls.length > 0) {
        const settled = await Promise.allSettled(readOnlyCalls.map(executeOneCall))
        for (let si = 0; si < settled.length; si++) {
          const outcome = settled[si]
          if (outcome.status === "fulfilled") {
            callResults.set(outcome.value.call.id, outcome.value)
          } else {
            const failedCall = readOnlyCalls[si]
            callResults.set(failedCall.id, {
              call: failedCall,
              result: {
                name: failedCall.name,
                status: "error",
                output: `Tool execution failed: ${outcome.reason?.message || "unknown error"}`,
                error: outcome.reason?.message || "unknown error"
              }
            })
          }
        }
      }

      // Execute write tools serially
      for (const call of writeCalls) {
        const outcome = await executeOneCall(call)
        callResults.set(outcome.call.id, outcome)
      }

      // Collect results in original order
      for (const call of response.toolCalls) {
        const entry = callResults.get(call.id)
        if (entry) {
          toolEvents.push({
            step,
            name: entry.call.name,
            args: entry.call.args,
            ...entry.result
          })
        }
      }

      // --- Build native tool_use / tool_result messages ---
      // Assistant message: text + tool_use blocks
      const assistantContent = []
      if (response.text) {
        assistantContent.push({ type: "text", text: response.text })
      }
      for (const call of response.toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args || {}
        })
      }
      await appendMessage(sessionId, "assistant", assistantContent, {
        mode,
        model,
        providerType,
        step,
        turnId,
        toolCallPhase: true
      })

      // User message: tool_result blocks (one per tool call, in order)
      const resultContent = []
      for (const call of response.toolCalls) {
        const entry = callResults.get(call.id)
        const output = entry?.result?.output || ""
        const isError = entry?.result?.status === "error"
        resultContent.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: output,
          is_error: isError
        })
      }
      await appendMessage(sessionId, "user", resultContent, {
        mode,
        model,
        providerType,
        step,
        turnId,
        synthetic: true
      })

      // --- Doom loop detection: 3x identical tool call → inject warning ---
      for (const call of response.toolCalls) {
        doomTracker.push(`${call.name}::${JSON.stringify(call.args || {})}`)
      }
      if (doomTracker.length > 6) doomTracker.splice(0, doomTracker.length - 6)
      if (doomTracker.length >= 3) {
        const last3 = doomTracker.slice(-3)
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          await appendMessage(sessionId, "user", "[DOOM LOOP DETECTED] You called the same tool with identical arguments 3 times consecutively. STOP repeating this approach — it will not work. Try a completely different strategy, re-read the relevant files, or ask the user for guidance.", {
            mode, model, providerType, step, turnId, synthetic: true
          })
          doomTracker.length = 0
        }
      }

      // --- Soft step warning: alert model when nearing the limit ---
      if (step === maxSteps - 2) {
        await appendMessage(sessionId, "user", `[STEP LIMIT WARNING] You have used ${step} of ${maxSteps} steps. You are running low — wrap up your current work, summarize progress, and list any remaining tasks.`, {
          mode, model, providerType, step, turnId, synthetic: true
        })
      }

      await EventBus.emit({
        type: EVENT_TYPES.TURN_STEP_FINISH,
        sessionId,
        turnId,
        payload: { step, toolCalls: response.toolCalls.length }
      })
    }

    finalReply = "Reached max steps. Review tool outputs and continue in a new turn."
    await appendMessage(sessionId, "assistant", finalReply, {
      mode,
      model,
      providerType,
      turnId,
      maxSteps: true
    })
    await markTurnFinished(sessionId)
    await EventBus.emit({
      type: EVENT_TYPES.TURN_FINISH,
      sessionId,
      turnId,
      payload: { maxSteps: true, reply: finalReply }
    })
    return {
      sessionId,
      turnId,
      reply: finalReply,
      emittedText: emittedAnyText,
      context: lastContextMeter,
      usage,
      toolEvents
    }
  } catch (error) {
    await markSessionStatus(sessionId, "error")
    await markTurnFinished(sessionId, recoveryEnabled)
    if (recoveryEnabled) {
      await updateSession(sessionId, {
        retryMeta: {
          inProgress: false,
          turnId,
          failedAt: Date.now(),
          error: error.message
        }
      })
    }
    await EventBus.emit({
      type: EVENT_TYPES.TURN_ERROR,
      sessionId,
      turnId,
      payload: { error: error.message }
    })
    return {
      sessionId,
      turnId,
      reply: `provider error: ${error.message}`,
      emittedText: emittedAnyText,
      context: lastContextMeter,
      usage,
      toolEvents
    }
  }
}
