/**
 * 0.4.0 单一权威模式表。
 *
 * 对外的 5 档扁平循环是 (lane, approval) 二元组的投影：
 *   - lane     执行航道，取值仍是 assistant / plan / longagent
 *   - approval 审批档位，喂给权限判定链
 *
 * lane 标识刻意与 0.3.x 保持一致，因此运行时执行链路（resolveMode、
 * executeTurn、system-prompt、touchSession）无需任何改动。
 */

export const APPROVAL_LEVELS = Object.freeze(["readonly", "manual", "accept-edits", "yolo"])

export const DEFAULT_APPROVAL = "manual"

export const MODE_CYCLE = Object.freeze([
  Object.freeze({
    id: "plan",
    lane: "plan",
    approval: "readonly",
    icon: "⏸",
    label: "Plan",
    hint: "只读规划，不修改文件"
  }),
  Object.freeze({
    id: "agent",
    lane: "assistant",
    approval: "manual",
    icon: "●",
    label: "Agent",
    hint: "编辑前需确认"
  }),
  Object.freeze({
    id: "agent-auto",
    lane: "assistant",
    approval: "accept-edits",
    icon: "▶",
    label: "Agent · Auto",
    hint: "自动接受编辑"
  }),
  Object.freeze({
    id: "ultra",
    lane: "longagent",
    approval: "accept-edits",
    icon: "⚡",
    label: "Ultra",
    hint: "多阶段自主编排"
  }),
  Object.freeze({
    id: "yolo",
    lane: "assistant",
    approval: "yolo",
    icon: "⚠",
    label: "YOLO",
    hint: "跳过全部审批"
  })
])

export const MODE_IDS = Object.freeze(MODE_CYCLE.map((mode) => mode.id))

export const DEFAULT_MODE_ID = "agent"

const MODE_BY_ID = new Map(MODE_CYCLE.map((mode) => [mode.id, mode]))

/**
 * 旧模式名 → 新模式 id。
 * 0.3.x 的 assistant/agent/code/coding/ask 都归一到 assistant lane，
 * 因此统一落到默认审批档的 `agent`。
 */
const LEGACY_MODE_ALIASES = Object.freeze({
  assistant: "agent",
  agent: "agent",
  code: "agent",
  coding: "agent",
  ask: "agent",
  plan: "plan",
  longagent: "ultra",
  ultra: "ultra"
})

/**
 * 旧权限等级 → 新审批档。
 *
 * 注意 0.3.x 的 `auto` 语义是「安全工具自动、编辑仍需确认」，
 * 等价于新的 `manual` 而非新的 `accept-edits`。新档位刻意避开 `auto`
 * 这个名字，防止同名不同义导致升级时静默放宽权限。
 */
const LEGACY_APPROVAL_ALIASES = Object.freeze({
  readonly: "readonly",
  review: "manual",
  auto: "manual",
  manual: "manual",
  edit: "accept-edits",
  "full-auto": "accept-edits",
  "accept-edits": "accept-edits",
  acceptedits: "accept-edits",
  yolo: "yolo"
})

/**
 * 自定义 agent 定义里的第四套权限词汇（readonly|full|default|none）。
 *
 * `full` 刻意不在表内：它的语义是「不设额外限制」，应当沿用全局审批档，
 * 而不是被当成 `accept-edits` 那一档去做 min()。把它映射成具体档位会让
 * YOLO 名不副实——assistant / ultra 这些主 agent 声明的正是 `full`。
 */
const AGENT_PERMISSION_ALIASES = Object.freeze({
  readonly: "readonly",
  none: "readonly",
  default: "manual"
})

/** agent 声明「不额外收紧」时的哨兵值。 */
export const AGENT_PERMISSION_INHERIT = "full"

export function getMode(modeId) {
  return MODE_BY_ID.get(String(modeId || "").toLowerCase()) || null
}

export function isModeId(modeId) {
  return MODE_BY_ID.has(String(modeId || "").toLowerCase())
}

export function laneOf(modeId) {
  return getMode(modeId)?.lane || "assistant"
}

export function approvalOf(modeId) {
  return getMode(modeId)?.approval || DEFAULT_APPROVAL
}

export function nextModeId(modeId) {
  const index = MODE_IDS.indexOf(String(modeId || "").toLowerCase())
  return MODE_IDS[index >= 0 ? (index + 1) % MODE_IDS.length : 0]
}

export function prevModeId(modeId) {
  const index = MODE_IDS.indexOf(String(modeId || "").toLowerCase())
  if (index < 0) return MODE_IDS[0]
  return MODE_IDS[(index - 1 + MODE_IDS.length) % MODE_IDS.length]
}

/**
 * 把任意新旧模式写法归一为模式 id。未知值回落到默认档。
 * 返回 null 表示输入完全无法识别，调用方可据此决定是否报错。
 */
export function modeIdFromLegacy(name) {
  const key = String(name || "").toLowerCase().trim()
  if (!key) return null
  if (MODE_BY_ID.has(key)) return key
  return LEGACY_MODE_ALIASES[key] || null
}

export function isLegacyModeName(name) {
  const key = String(name || "").toLowerCase().trim()
  return Boolean(LEGACY_MODE_ALIASES[key]) && !MODE_BY_ID.has(key)
}

/** 把任意新旧权限等级归一为审批档。未知值回落到 `manual`。 */
export function approvalFromLegacy(level) {
  const key = String(level || "").toLowerCase().trim()
  if (!key) return null
  return LEGACY_APPROVAL_ALIASES[key] || null
}

export function isLegacyApprovalName(level) {
  const key = String(level || "").toLowerCase().trim()
  return Boolean(LEGACY_APPROVAL_ALIASES[key]) && !APPROVAL_LEVELS.includes(key)
}

/**
 * 自定义 agent 的 permission 字段（readonly|full|default|none）→ 审批档。
 * 返回 null 表示不收紧（未声明，或声明为 `full`）。
 */
export function approvalFromAgentPermission(value) {
  const key = String(value || "").toLowerCase().trim()
  if (!key || key === AGENT_PERMISSION_INHERIT) return null
  if (APPROVAL_LEVELS.includes(key)) return key
  return AGENT_PERMISSION_ALIASES[key] || approvalFromLegacy(key)
}

/** 按模式 id 找出它在循环里的位置，供 UI 渲染进度指示。 */
export function modeIndex(modeId) {
  return MODE_IDS.indexOf(String(modeId || "").toLowerCase())
}

/** 由 lane + approval 反查模式 id，用于从旧 session 状态重建 modeId。 */
export function modeIdFromLaneAndApproval(lane, approval) {
  const laneKey = String(lane || "").toLowerCase()
  const approvalKey = approvalFromLegacy(approval) || DEFAULT_APPROVAL
  const exact = MODE_CYCLE.find((mode) => mode.lane === laneKey && mode.approval === approvalKey)
  if (exact) return exact.id
  const byLane = MODE_CYCLE.find((mode) => mode.lane === laneKey)
  return byLane?.id || DEFAULT_MODE_ID
}
