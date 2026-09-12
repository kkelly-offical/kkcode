import { createHash } from "node:crypto"

/**
 * Goal 与验收判据的数据模型 —— 0.5.0 目标模式的地基。
 *
 * 在此之前「目标达成」没有可执行的定义：task.acceptance 是自由文本，唯一的
 * 运行期消费点是把它拼进子 agent 的提示词里靠自觉；stage 是否完成看的是
 * 「plannedFiles 是否都被 write/edit 摸过」；整个 run 算不算成功看的是模型
 * 有没有说出 [TASK_COMPLETE]。三层判据没有一层看的是「东西真的做出来了吗」。
 *
 * 这里把判据变成机器可执行的结构，同时保留三条安全属性：
 *  1. 无法机器化的散文一律落到 `manual`，而 manual **永远不能被自动判为达成**
 *     —— 于是「Task objective is fully usable」这类主观句子自动变得无害：
 *     它会把目标推进 blocked_manual 逼出一次用户确认，而不是静默算过。
 *  2. blocking 判据不能被静默删除：删除必须给理由，且强制出现在最终报告里。
 *  3. 判据在 H0 冻结后，运行期只读。
 */

export const CRITERION_KINDS = Object.freeze([
  "file_exists", "content_match", "command_exit", "test_pass", "gate_pass", "manual"
])

export const CRITERION_PASS = "pass"
export const CRITERION_FAIL = "fail"
export const CRITERION_UNKNOWN = "unknown"       // 无法评估（工具缺失 / 门禁禁用 / 命令被拒）
export const CRITERION_MANUAL = "pending_manual" // 需要人；没有任何代码路径能把它变成 pass

export const GOAL_INTENTS = Object.freeze(["code", "research", "docs", "ops", "mixed"])

const MAX_CRITERIA = 12
const MAX_SUBGOALS = 6

let criterionCounter = 0
function nextCriterionId(owner) {
  criterionCounter += 1
  return `${owner || "g"}_c${criterionCounter}`
}

/** 测试用：让生成的 id 可预测。 */
export function resetCriterionCounter() {
  criterionCounter = 0
}

// ---------------------------------------------------------------------------
// 判据归一化
// ---------------------------------------------------------------------------

const COMMAND_HEAD = /^(node|npm|npx|pnpm|yarn|python3?|pytest|go|cargo|make|tsc|eslint|jest|vitest|mocha|git)\b/
const FILE_PATH = /^[\w@./-]+\.(mjs|cjs|js|ts|tsx|jsx|json|py|go|rs|md|ya?ml|css|html|txt|sh)$/
const FILE_EXISTS_PHRASE = /(?:file\s+|文件\s*)([\w@./-]+\.[\w]+)\s*(?:exists|存在)/i
const EXPORTS_PHRASE = /exports?\s+(\w+)\s+from\s+([\w@./-]+\.[\w]+)/i
const CONTAINS_PHRASE = /([\w@./-]+\.[\w]+)\s+(?:contains|包含)\s+(.+)/i
const GATE_PHRASE = /^(build|test|lint|review)\s+(?:passes|通过)$/i

/** 从命令字符串拆 argv。只处理简单引号，不解释 shell 语法。 */
export function splitArgv(command) {
  const argv = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of String(command || "").matchAll(pattern)) {
    argv.push(match[1] ?? match[2] ?? match[3])
  }
  return argv
}

/**
 * 把一条字符串判据解析成结构化判据。
 *
 * 启发式的**兜底是安全属性**：解析不出来的散文一律落到 `manual`。0.4.x 的
 * defaultStagePlan 生成的 "Task objective is fully usable" 就是典型 ——
 * 它不能机器验证，也绝不能被当成已通过。
 */
export function parseCriterionString(text, { id = "", owner = "", source = "legacy_string" } = {}) {
  const raw = String(text || "").trim()
  if (!raw) return null
  const base = { id: id || nextCriterionId(owner), text: raw, severity: "blocking", owner, source }

  // 1. 命令：`npm test passes` / `node --check src/foo.mjs`
  const commandText = raw.replace(/\s+(?:passes|通过|成功)\s*$/i, "")
  if (COMMAND_HEAD.test(commandText)) {
    const argv = splitArgv(commandText)
    const isTestRunner = /^(pytest|jest|vitest|mocha)$/.test(argv[0]) || /\btests?\b|--test\b/.test(commandText)
    return { ...base, kind: isTestRunner ? "test_pass" : "command_exit", spec: { command: argv[0], args: argv.slice(1), expect: 0 } }
  }

  // 2. 纯文件路径，或「file X exists」句式
  if (FILE_PATH.test(raw)) {
    return { ...base, kind: "file_exists", spec: { path: raw, minBytes: 1 } }
  }
  const fileMatch = raw.match(FILE_EXISTS_PHRASE)
  if (fileMatch) {
    return { ...base, kind: "file_exists", spec: { path: fileMatch[1], minBytes: 1 } }
  }

  // 3. 内容匹配：「exports verifyGoal from src/x.mjs」/「README.md contains 0.5.0」
  const exportsMatch = raw.match(EXPORTS_PHRASE)
  if (exportsMatch) {
    return {
      ...base,
      kind: "content_match",
      spec: { path: exportsMatch[2], pattern: `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${exportsMatch[1]}\\b` }
    }
  }
  const containsMatch = raw.match(CONTAINS_PHRASE)
  if (containsMatch) {
    return {
      ...base,
      kind: "content_match",
      spec: { path: containsMatch[1], pattern: escapeRegExp(containsMatch[2].trim()) }
    }
  }

  // 4. 门禁：「build passes」
  const gateMatch = raw.match(GATE_PHRASE)
  if (gateMatch) {
    return { ...base, kind: "gate_pass", spec: { gate: gateMatch[1].toLowerCase() } }
  }

  // 5. 兜底：manual。这是安全属性，不是偷懒。
  return { ...base, kind: "manual", spec: { question: raw } }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 归一化一条对象形态的判据；kind 非法或缺关键字段时返回 null。 */
export function normalizeCriterionObject(input, { id = "", owner = "", source = "blueprint" } = {}) {
  if (!input || typeof input !== "object") return null
  const kind = String(input.kind || "").trim()
  if (!CRITERION_KINDS.includes(kind)) {
    // kind 不认识 —— 有 text 的话按字符串启发式重解析，绝不静默丢弃
    return input.text ? parseCriterionString(input.text, { id, owner, source }) : null
  }
  const spec = input.spec && typeof input.spec === "object" ? { ...input.spec } : {}
  const base = {
    id: String(input.id || "").trim() || id || nextCriterionId(owner),
    kind,
    text: String(input.text || "").trim() || describeSpec(kind, spec),
    severity: input.severity === "advisory" ? "advisory" : "blocking",
    owner,
    source
  }
  switch (kind) {
    case "file_exists":
      if (!spec.path) return null
      return { ...base, spec: { path: String(spec.path), minBytes: Math.max(1, Number(spec.minBytes) || 1) } }
    case "content_match":
      if (!spec.path || !spec.pattern) return null
      return { ...base, spec: { path: String(spec.path), pattern: String(spec.pattern), flags: String(spec.flags || ""), negate: spec.negate === true } }
    case "command_exit":
    case "test_pass": {
      const argv = spec.command
        ? [String(spec.command), ...(Array.isArray(spec.args) ? spec.args.map(String) : [])]
        : splitArgv(spec.run || "")
      if (!argv.length) return null
      return { ...base, spec: { command: argv[0], args: argv.slice(1), expect: Number.isInteger(spec.expect) ? spec.expect : 0, timeoutMs: Number(spec.timeoutMs) || 0 } }
    }
    case "gate_pass":
      if (!spec.gate) return null
      return { ...base, spec: { gate: String(spec.gate).toLowerCase() } }
    case "manual":
      return { ...base, spec: { question: String(spec.question || base.text) } }
    default:
      return null
  }
}

function describeSpec(kind, spec) {
  switch (kind) {
    case "file_exists": return `${spec.path} 存在且非空`
    case "content_match": return `${spec.path} 匹配 /${spec.pattern}/`
    case "command_exit": return `${spec.run || spec.command} 退出码 ${spec.expect ?? 0}`
    case "test_pass": return `${spec.run || spec.command} 测试通过`
    case "gate_pass": return `${spec.gate} 门禁通过`
    case "manual": return String(spec.question || "需要人工确认")
    default: return ""
  }
}

/**
 * 归一化 acceptance 列表。字符串与对象混填都接受 —— 这是对现有
 * task.acceptance 的**扩展**而非替换，0.4.x 的纯字符串计划照常工作。
 */
export function normalizeAcceptance(list, { owner = "", source = "blueprint" } = {}) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const criterion = typeof item === "string"
      ? parseCriterionString(item, { owner, source: "legacy_string" })
      : normalizeCriterionObject(item, { owner, source })
    if (criterion) out.push(criterion)
    if (out.length >= MAX_CRITERIA) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 意图分类（包容性的入口）
// ---------------------------------------------------------------------------

const RESEARCH_SIGNALS = /调研|研究|分析|评估|对比|梳理|盘点|audit|investigate|survey|analy[sz]e|research|compare|review the state/i
const DOCS_SIGNALS = /文档|说明书?|教程|指南|readme|changelog|write.?up|document(?:ation)?|\.md\b/i
const OPS_SIGNALS = /部署|发布|上线|回滚|迁移数据|监控|告警|运维|deploy|rollout|rollback|provision|dockerfile|\bci\b|k8s|kubernetes/i
const CODE_SIGNALS = /实现|修复|重构|开发|编写|调试|优化性能|加(?:个|一个)?功能|implement|fix|refactor|debug|feature|bug|api|function|module|test/i

/**
 * 判断目标类型。不再有硬拒绝 —— 调研 / 文档 / 运维同样是可执行目标，
 * 差别只在验收判据的形态（见 intentProfile）。
 */
const WRITES_A_DOC = /(写|撰写|编写|整理|write|draft|produce)[^。.!?]{0,12}(文档|指南|教程|说明|报告|readme|changelog|documentation|guide|report)/i

export function classifyGoalIntent(objective) {
  const text = String(objective || "")
  const hits = []
  if (RESEARCH_SIGNALS.test(text)) hits.push("research")
  if (DOCS_SIGNALS.test(text)) hits.push("docs")
  if (OPS_SIGNALS.test(text)) hits.push("ops")
  if (CODE_SIGNALS.test(text)) hits.push("code")
  if (hits.length === 0) return "code"
  if (hits.length === 1) return hits[0]
  // 「写一份部署指南」——写作动词直接指向文档、且没有真正的编码信号时，
  // 交付物是文档；ops 词只是文档的**主题**。没有这条规则它会被判成 mixed，
  // 白跑 scaffold 与 build。「实现 X 并写文档」含编码信号，仍走 mixed。
  if (hits.includes("docs") && !hits.includes("code") && WRITES_A_DOC.test(text)) return "docs"
  // code + docs 之类的真组合（「实现 X 并写文档」）按 mixed 走并集
  return "mixed"
}

/**
 * 目标类型 → 运行期 profile（不写用户配置）。
 *
 * 关键在 requirePlannedFiles：0.4.x 的核验对「没声明 plannedFiles 的 stage」
 * 返回 UNKNOWN 走原重跑逻辑 —— 非编码目标因此必然原地打转。research/docs/ops
 * 的达成与否由 goal.criteria 直接判定，不再依赖文件清单。
 */
export function intentProfile(intent) {
  switch (intent) {
    case "research":
      return { scaffold: false, buildTestGates: false, requirePlannedFiles: false, preferredKinds: ["file_exists", "content_match", "manual"] }
    case "docs":
      return { scaffold: false, buildTestGates: false, requirePlannedFiles: false, preferredKinds: ["file_exists", "content_match", "command_exit"] }
    case "ops":
      return { scaffold: false, buildTestGates: false, requirePlannedFiles: false, preferredKinds: ["command_exit", "content_match", "manual"] }
    case "mixed":
      return { scaffold: true, buildTestGates: true, requirePlannedFiles: false, preferredKinds: CRITERION_KINDS.slice(0, 5) }
    case "code":
    default:
      return { scaffold: true, buildTestGates: true, requirePlannedFiles: true, preferredKinds: CRITERION_KINDS.slice(0, 5) }
  }
}

// ---------------------------------------------------------------------------
// 目标树
// ---------------------------------------------------------------------------

/**
 * 归一化目标树。
 *
 * @param {object} input blueprint 输出的 goal 块
 * @param {{objective: string, stageIds?: string[]}} context
 * @returns {{goal: object|null, errors: string[]}}
 *
 * 约束（violation 记进 errors，调用方决定是否要求 blueprint 重出）：
 *  - 深度上限 2：root → subGoals，不再往下（CLI 上更深的层次只会毁掉报告可读性）
 *  - 子目标 ≤ 6
 *  - 每个 stage 归属恰好一个子目标（stageIds 不重叠）
 *  - root 至少 1 条 blocking 判据（或有子目标）
 */
export function normalizeGoal(input, { objective, stageIds = [] } = {}) {
  const errors = []
  if (!input || typeof input !== "object") {
    return { goal: null, errors: ["goal block missing or not an object"] }
  }

  const intent = GOAL_INTENTS.includes(input.intent) ? input.intent : classifyGoalIntent(objective)
  const goal = {
    goalId: String(input.goalId || "").trim() || `goal_${Date.now().toString(36)}`,
    objective: String(input.objective || objective || "").trim(),
    intent,
    criteria: normalizeAcceptance(input.criteria, { owner: "root", source: "blueprint" }),
    nonGoals: Array.isArray(input.nonGoals) ? input.nonGoals.map(String).slice(0, 10) : [],
    subGoals: [],
    frozenAt: null,
    revisions: []
  }

  const rawSubs = Array.isArray(input.subGoals) ? input.subGoals : []
  if (rawSubs.length > MAX_SUBGOALS) {
    errors.push(`subGoals exceed ${MAX_SUBGOALS} (got ${rawSubs.length}) — merge related deliverables`)
  }
  const seenStageIds = new Map()
  for (const [index, raw] of rawSubs.slice(0, MAX_SUBGOALS).entries()) {
    if (!raw || typeof raw !== "object") continue
    if (Array.isArray(raw.subGoals) && raw.subGoals.length) {
      errors.push(`subGoal ${index + 1} nests its own subGoals — depth is capped at 2`)
    }
    const sub = {
      goalId: String(raw.goalId || "").trim() || `${goal.goalId}_s${index + 1}`,
      title: String(raw.title || raw.objective || "").trim() || `子目标 ${index + 1}`,
      criteria: normalizeAcceptance(raw.criteria, { owner: `s${index + 1}`, source: "blueprint" }),
      stageIds: Array.isArray(raw.stageIds) ? raw.stageIds.map(String).filter(Boolean) : [],
      optional: raw.optional === true,
      status: "pending"
    }
    for (const stageId of sub.stageIds) {
      if (seenStageIds.has(stageId)) {
        errors.push(`stage ${stageId} belongs to both ${seenStageIds.get(stageId)} and ${sub.goalId} — every stage must have exactly one owner`)
      } else {
        seenStageIds.set(stageId, sub.goalId)
      }
      if (stageIds.length && !stageIds.includes(stageId)) {
        errors.push(`subGoal ${sub.goalId} references unknown stage ${stageId}`)
      }
    }
    goal.subGoals.push(sub)
  }

  if (!goal.criteria.length && !goal.subGoals.length) {
    errors.push("goal has no criteria and no subGoals — nothing to verify against")
  }

  return { goal, errors }
}

/** 冻结目标：H0 用户确认后调用。此后运行期只读，修订必须走 reviseGoal。 */
export function freezeGoal(goal, { round = 1 } = {}) {
  return { ...goal, frozenAt: { at: new Date().toISOString(), round } }
}

/**
 * 修订目标判据。新增自由；**删除 blocking 判据必须给非空理由**，且删除记录
 * 会被强制放进最终报告的「验收标准变更」小节 —— 不能靠禁止（模型总能重写
 * 计划），只能靠留痕并向用户展示。manual 判据永不可删。
 */
export function reviseGoal(goal, { round, reason = "", add = [], drop = [] } = {}) {
  const errors = []
  const added = normalizeAcceptance(add, { owner: "root", source: "replan" })
  const dropped = []

  for (const dropRequest of drop) {
    const dropId = typeof dropRequest === "string" ? dropRequest : dropRequest?.id
    const dropReason = typeof dropRequest === "object" ? String(dropRequest?.reason || "").trim() : String(reason || "").trim()
    const target = goal.criteria.find((c) => c.id === dropId)
    if (!target) { errors.push(`cannot drop unknown criterion ${dropId}`); continue }
    if (target.kind === "manual") { errors.push(`criterion ${dropId} is manual and can never be dropped`); continue }
    if (target.severity === "blocking" && !dropReason) {
      errors.push(`dropping blocking criterion ${dropId} requires a reason`)
      continue
    }
    dropped.push({ ...target, dropReason })
  }

  const droppedIds = new Set(dropped.map((c) => c.id))
  const revised = {
    ...goal,
    criteria: [...goal.criteria.filter((c) => !droppedIds.has(c.id)), ...added],
    revisions: [
      ...goal.revisions,
      {
        round,
        reason: String(reason || ""),
        added: added.map((c) => ({ id: c.id, text: c.text })),
        removed: dropped.map((c) => ({ id: c.id, text: c.text, reason: c.dropReason })),
        at: new Date().toISOString()
      }
    ]
  }
  return { goal: revised, errors }
}

// ---------------------------------------------------------------------------
// 计划签名（停滞检测用）
// ---------------------------------------------------------------------------

/**
 * 计划的结构签名：stage/task/文件清单相同则签名相同，措辞变化不影响。
 * 重规划产出与上一轮相同签名的计划 → 直接判无进展，堵死「模型每轮吐出
 * 同一份计划」的死循环。
 */
export function planSignature(stagePlan) {
  const stages = (stagePlan?.stages || []).map((stage) =>
    [
      stage.stageId,
      ...(stage.tasks || []).map((task) => `${task.taskId}:${(task.plannedFiles || []).join(",")}`)
    ].join("|")
  )
  return createHash("sha1").update(stages.join("\n")).digest("hex").slice(0, 12)
}
