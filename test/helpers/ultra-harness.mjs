import { EventBus } from "../../src/core/events.mjs"

/**
 * Ultra 端到端测试骨架。
 *
 * 在此之前仓库里没有任何能真正驱动 runHybridLongAgent 走完 H0–H7 的测试：
 * longagent-continuous 看着像端到端，实际上子任务跑在独立进程里、拿不到父进程
 * 注册的 mock provider，全程空转（见 background-mock.mjs 的说明）。
 *
 * 这里提供三样东西：按提示词内容应答的 provider、事件序列采集、以及把结果里
 * 随时间变化的字段抹平的归一化函数 —— 合起来就能对 Ultra 的行为做快照。
 */

const ZERO_USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

function contentToText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((piece) => (typeof piece === "string" ? piece : String(piece?.text || "")))
    .join("\n")
}

function fullText(input) {
  const parts = input?.system ? [String(input.system)] : []
  for (const message of input?.messages || []) parts.push(contentToText(message?.content))
  return parts.join("\n")
}

function lastUserText(input) {
  const messages = input?.messages || []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return contentToText(messages[i]?.content)
  }
  return contentToText(messages[messages.length - 1]?.content)
}

const STAGE_HEADER = /=== LONGAGENT STAGE (\d)\/4/g

/**
 * 判断「这次请求属于哪个阶段」——取消息历史里**最后出现**的阶段标记。
 *
 * 两个坑都在这一行上：
 *
 * 1. 同一会话里各阶段共享消息历史，H2 的请求里也带着 H1 的提示词。取第一个
 *    标记会永远得到 PREVIEW —— blueprint 拿到探查文本，计划解析失败退回默认
 *    单 stage 计划，而外面看起来一切正常。
 * 2. 一个回合可能有多步，后续步骤的最后一条消息是工具结果或续写指令，
 *    里面根本没有阶段标记。只看最后一条消息会落到 fallback，于是整个回合的
 *    最终回复变成了兜底文本 —— blueprint 同样解析不出计划，H5 同样看不到
 *    完成标记而空转满 20 轮。
 *
 * 取「历史中最后一个标记」对这两种情况都正确。
 */
export function currentStageOf(input) {
  let stage = null
  for (const match of fullText(input).matchAll(STAGE_HEADER)) stage = Number(match[1])
  return stage
}

/**
 * 按提示词内容应答的 provider。
 *
 * 比「按调用顺序返回第 N 条」健壮得多 —— 阶段顺序一旦变化，顺序型 mock 会
 * 悄悄错位，而基于内容的规则要么命中要么落到 fallback，不会假装成功。
 *
 * @param {Array<{stage?: number, match?: RegExp, reply: string}>} rules 按序匹配，先命中先返回。
 *   `stage` 按 Ultra 阶段号（1=preview / 2=blueprint / 3=coding / 4=debugging）匹配，
 *   `match` 对最后一条用户消息做正则匹配。
 * @param {{fallback?: string, onRequest?: (info) => void}} options
 */
export function createScriptedProvider(rules = [], { fallback = "ok", onRequest = null } = {}) {
  function pick(input) {
    const last = lastUserText(input)
    const stage = currentStageOf(input)
    if (onRequest) onRequest({ stage, last })
    for (const rule of rules) {
      if (rule.match && rule.match.test(last)) return rule.reply
      if (rule.stage != null && rule.stage === stage) return rule.reply
    }
    return fallback
  }
  return {
    async request(input) {
      return { text: pick(input), toolCalls: [], usage: { ...ZERO_USAGE } }
    },
    async *requestStream(input) {
      yield { type: "text", content: pick(input) }
      yield { type: "usage", usage: { ...ZERO_USAGE } }
    }
  }
}

/** 把 stage plan 包成 blueprint agent 会输出的围栏块。 */
export function stagePlanFence(plan) {
  return [
    "## Architecture",
    "Two modules, no shared files.",
    "",
    "```stage_plan_json",
    JSON.stringify(plan),
    "```"
  ].join("\n")
}

/** 采集 EventBus 上的事件序列。 */
export function captureEvents({ sessionId = null } = {}) {
  const events = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (sessionId && event.sessionId && event.sessionId !== sessionId) return
    events.push(event)
  })
  return {
    events,
    types: () => events.map((e) => e.type),
    byType: (type) => events.filter((e) => e.type === type),
    stop: () => unsubscribe()
  }
}

const VOLATILE_KEYS = new Set([
  "turnId", "elapsed", "createdAt", "updatedAt", "startedAt", "endedAt",
  "heartbeatAt", "lastHeartbeatAt", "frozenAt", "evaluatedAt", "at", "ts"
])

/**
 * 抹掉随时间/进程变化的字段，让结果可以做深比较。
 * 保留 taskProgress、gateStatus、stageIndex 这些**语义**字段 —— 快照的意义
 * 正是锁住它们。
 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue
      out[key] = normalize(inner)
    }
    return out
  }
  return value
}

/** 构造一份最小可用的 Ultra 配置，交互阶段默认全关。 */
export function ultraConfig({ providerName = "mock_ultra", longagent = {}, hybrid = {}, gates = {} } = {}) {
  return {
    config: {
      provider: {
        default: providerName,
        [providerName]: { default_model: "mock-model", timeout_ms: 5000, stream: false, retry_attempts: 1 }
      },
      agent: {
        default_mode: "longagent",
        // 必须用产品默认值。压到 1 会让 agent 模式的回合以
        // "Reached max steps. Review tool outputs and continue in a new turn."
        // 收尾，模型的文本根本到不了调用方 —— blueprint 解析不到计划会退回
        // 默认单 stage 计划，H5 也永远看不到完成标记而空转满 20 轮，
        // 而这一切在外面看起来只是「跑完了」。
        max_steps: 8,
        longagent: {
          max_gate_attempts: 1,
          hybrid: {
            intake: false,
            intake_user_confirm: false,
            blueprint_review: false,
            completion_validation: false,
            cross_review: false,
            project_memory: false,
            task_bus: false,
            checkpoint_resume: false,
            checkpoint_cleanup: false,
            incremental_gates: false,
            budget_awareness: false,
            ...hybrid
          },
          scaffold: { enabled: false },
          git: { enabled: false },
          usability_gates: {
            prompt_user: "never",
            build: { enabled: false }, test: { enabled: false }, review: { enabled: false },
            health: { enabled: false }, budget: { enabled: false },
            ...gates
          },
          ...longagent
        }
      },
      permission: { level: "yolo", rules: [] },
      session: { max_history: 10, recovery: true },
      tool: { sources: { builtin: false, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}
