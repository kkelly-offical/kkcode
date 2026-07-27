/**
 * `/provider add` 与 `/provider edit` 的表单流程。
 *
 * ## 为什么是表单而不是十二步逐行问答
 *
 * 旧向导（wizard.mjs 的状态机）把菜单 print 进对话记录，每次回车跑一步。
 * 在 TUI 里这意味着向导输入（`1`、`y`、一个 base URL）要先穿过模式自动路由
 * （可能直接改掉用户的模式）、busy spinner 和 `@` 文件引用解析，才轮到向导
 * 拦截 —— 因为它们对输入管线来说就是普通消息。
 *
 * 表单走提问浮层（`askQuestionInteractive`）：模态作用域直接吃掉按键，
 * 上面那串问题在结构上不存在。降级也是现成的 —— 无 TUI 时 readline 逐题问，
 * 非交互时返回空答案（表单据此取消）。
 *
 * ## 三条纪律（对应 0.7.3 的用户要求）
 *
 * 1. **API Key 直接输入**，明文写进 `~/.kkcode/config.yaml` 的 `api_key`。
 *    输入时遮蔽（`secret: true`），确认页只显示末四位，不进对话记录与日志。
 *    这是用户明确要求并确认过的行为。留空 = 不写凭据（本地服务，或走预设的
 *    环境变量）。
 * 2. **只写用户提供或确认过的字段**。`base_url` 预填预设值但显示出来可编辑；
 *    `context_limit` 留空就不写；`thinking` 明确选了才写，且只写
 *    `{ type: "enabled" }` —— `budget_tokens` 用户没给过，运行时自有缺省。
 * 3. **确认页所见即所写**：预览里的每一行就是将要落盘的字段，没有背后追加。
 */

import { VENDOR_PRESETS, saveProviderConfig } from "./wizard.mjs"
import { discoverModelsForProvider } from "./model-catalog.mjs"
import { askQuestionInteractive } from "../tool/question-prompt.mjs"
import { QUESTION_SKIPPED } from "../repl/dialog-router.mjs"

/** 表单答案 → 干净字符串。跳过哨兵与 undefined 一律折成空串。 */
const clean = (value) => {
  const text = typeof value === "string" ? value.trim() : ""
  return text === QUESTION_SKIPPED ? "" : text
}

const maskKey = (key) => (key.length > 4 ? `…${key.slice(-4)}` : "…set")

const CUSTOM_VENDORS = [
  { label: "Custom (OpenAI-compatible)", value: "custom-openai", type: "openai-compatible" },
  { label: "Custom (Anthropic-compatible)", value: "custom-anthropic", type: "anthropic" },
  { label: "Custom (Gateway)", value: "custom-gateway", type: "gateway" }
]

/** 轮 A：选厂商。选项从 VENDOR_PRESETS 派生 —— 不手写第二份清单。 */
function vendorQuestion() {
  return {
    id: "vendor",
    header: "Provider",
    text: "选择要添加的 Provider",
    allowCustom: false,
    options: [
      ...Object.entries(VENDOR_PRESETS).map(([key, preset]) => ({
        label: preset.label || key,
        value: key,
        description: preset.base_url || (preset.protocols ? "multi-protocol" : "")
      })),
      ...CUSTOM_VENDORS.map(({ label, value }) => ({ label, value, description: "" }))
    ]
  }
}

/**
 * 解析轮 A 的选择成一份「基底」：type / base_url 默认值 / 建议名称。
 * coding-plan 这类多协议预设与自定义 gateway 需要补问协议，由 needsProtocol 标记。
 */
function resolveVendorBase(vendorValue) {
  const custom = CUSTOM_VENDORS.find((c) => c.value === vendorValue)
  if (custom) {
    return {
      isCustom: true,
      preset: null,
      suggestedName: "",
      type: custom.type,
      baseUrl: "",
      needsProtocol: custom.type === "gateway"
    }
  }
  const preset = VENDOR_PRESETS[vendorValue]
  if (!preset) return null
  return {
    isCustom: false,
    preset,
    suggestedName: vendorValue,
    type: preset.type || null,
    baseUrl: preset.base_url || "",
    needsProtocol: Boolean(preset.protocols)
  }
}

const sanitizeName = (raw) => clean(raw).replace(/[^a-z0-9_-]/gi, "_").toLowerCase()

/**
 * 轮 C：细节表单。字段按「这次配置真的需要什么」出，不问用不上的。
 * 每个字段的 default 会被预填进编辑缓冲区（dialog-router 的 bufferState），
 * 所以「预设值可见、可编辑」不需要任何额外机制。
 */
function detailQuestions(base, { existingNames }) {
  const questions = [
    {
      id: "name",
      header: "Name",
      text: "Provider 名称（写进配置的键名，小写字母/数字/-/_）",
      default: base.suggestedName,
      description: existingNames.length ? `已有：${existingNames.join(", ")}（重名会合并更新）` : ""
    },
    {
      id: "base_url",
      header: "Base URL",
      text: "API Base URL —— 确认或修改后落盘，写进配置的就是这里显示的值",
      default: base.baseUrl
    },
    {
      id: "api_key",
      header: "API Key",
      text: "API Key（输入时不回显，明文保存到 ~/.kkcode/config.yaml）",
      secret: true,
      description: base.preset?.key_env
        ? `留空 = 不保存密钥，运行时从环境变量 ${base.preset.key_env} 读取`
        : "留空 = 不配置凭据（本地服务通常不需要）"
    },
    {
      id: "context_limit",
      header: "Context",
      text: "上下文长度（tokens）。留空 = 不写入配置，运行时用内置缺省",
      default: ""
    }
  ]
  if (base.preset?.supports_thinking) {
    questions.push({
      id: "thinking",
      header: "Thinking",
      text: "启用 thinking（扩展思考）模式？",
      allowCustom: false,
      options: [
        { label: "不写入配置", value: "skip", description: "留给运行时决定（默认）" },
        { label: "启用", value: "enabled", description: "写入 thinking: { type: enabled }" }
      ]
    })
  }
  return questions
}

/** 用表单当前值拼一份临时 configState，让模型发现走与 /model 完全相同的链路。 */
function draftConfigState(name, entry) {
  const provider = { default: name, [name]: entry }
  return {
    config: { provider },
    source: { userRaw: { provider: { [name]: { ...entry } } }, projectRaw: {}, envOverlay: {} }
  }
}

/**
 * 轮 D：选模型。发现成功给单选（前 30 个 + 手动），失败直接自由文本。
 * 发现失败不是错误 —— 本地服务、离线、密钥权限不足都会走到，手动输入永远可用。
 */
async function askModel({ name, entry, defaultModel, ask, discover }) {
  let discovered = []
  try {
    const result = await discover(draftConfigState(name, entry), name, { refresh: true })
    discovered = (result?.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean)
  } catch {
    discovered = []
  }

  if (discovered.length) {
    const MANUAL = "(manual input)"
    const picked = await ask({
      questions: [{
        id: "model",
        header: "Model",
        text: `默认模型（发现 ${discovered.length} 个）`,
        allowCustom: false,
        options: [
          ...discovered.slice(0, 30).map((id) => ({ label: id, value: id, description: "" })),
          { label: MANUAL, value: MANUAL, description: "手动输入模型 ID" }
        ]
      }]
    })
    const chosen = clean(picked.model)
    if (chosen && chosen !== MANUAL) return chosen
  }

  const manual = await ask({
    questions: [{
      id: "model",
      header: "Model",
      text: "默认模型 ID（如 gpt-4o、claude-sonnet-4-5）",
      default: defaultModel || ""
    }]
  })
  return clean(manual.model)
}

/**
 * 组装将要写盘的条目。**这里出现的每个字段都来自用户的输入或确认** ——
 * 旧向导在这一步塞过三样用户没答过的东西（preset 的 base_url、静默继承的
 * context_limit、硬编码的 budget_tokens: 8000），一样都不许再有。
 */
function buildEntry({ base, protocol, answers, apiKey, model }) {
  const entry = {}
  if (base.type) entry.type = base.type
  if (base.needsProtocol && protocol) {
    if (base.isCustom) entry.protocol = protocol
    else {
      // 多协议预设（coding-plan）：协议决定 type 与 base_url 的**默认值**，
      // base_url 仍以用户在表单里确认过的为准（已在 answers 里）。
      const chosen = base.preset.protocols[protocol]
      if (chosen?.type) entry.type = chosen.type
    }
  }
  const baseUrl = clean(answers.base_url)
  if (baseUrl) entry.base_url = baseUrl
  if (apiKey) entry.api_key = apiKey
  else if (base.preset?.key_env) entry.api_key_env = base.preset.key_env
  if (model) entry.default_model = model
  const contextLimit = Number.parseInt(clean(answers.context_limit), 10)
  if (Number.isFinite(contextLimit) && contextLimit >= 1024) entry.context_limit = contextLimit
  if (clean(answers.thinking) === "enabled") entry.thinking = { type: "enabled" }
  return entry
}

/** 确认页文本：所见即所写。密钥只给末四位。 */
export function previewEntry(name, entry, { setDefault = true } = {}) {
  const lines = [`provider.${name}:`]
  for (const [key, value] of Object.entries(entry)) {
    if (key === "api_key") lines.push(`  api_key: ${maskKey(String(value))}（明文保存）`)
    else if (key === "thinking") lines.push("  thinking: { type: enabled }")
    else lines.push(`  ${key}: ${value}`)
  }
  if (setDefault) lines.push(`provider.default: ${name}`)
  return lines.join("\n")
}

/**
 * `/provider add` 的入口。
 *
 * @returns {Promise<{saved: boolean, name?: string, configPatch?: object, reason?: string}>}
 */
export async function runProviderAddForm({
  configState,
  ask = askQuestionInteractive,
  discover = discoverModelsForProvider
} = {}) {
  // provider 段里混着非 provider 的配置键（default / strict_mode / model_context）。
  // 真实终端验收时它们全被当成「已有 provider」列了出来 —— 判据改成
  // 「值是对象、且不在保留键里」，与 core-shell 的 configuredProviders 同一套。
  const RESERVED = new Set(["default", "strict_mode", "model_context"])
  const providerBag = configState?.config?.provider || {}
  const existingNames = Object.keys(providerBag)
    .filter((k) => !RESERVED.has(k) && providerBag[k] && typeof providerBag[k] === "object")

  const vendorAnswers = await ask({ questions: [vendorQuestion()] })
  const vendorValue = clean(vendorAnswers.vendor)
  if (!vendorValue) return { saved: false, reason: "cancelled" }
  const base = resolveVendorBase(vendorValue)
  if (!base) return { saved: false, reason: "cancelled" }

  let protocol = ""
  if (base.needsProtocol) {
    const options = base.isCustom
      ? [
          { label: "OpenAI-compatible", value: "openai", description: "" },
          { label: "Anthropic-compatible", value: "anthropic", description: "" }
        ]
      : Object.keys(base.preset.protocols).map((key) => ({
          label: key,
          value: key,
          description: base.preset.protocols[key]?.base_url || ""
        }))
    const protocolAnswers = await ask({
      questions: [{ id: "protocol", header: "Protocol", text: "选择 API 协议", allowCustom: false, options }]
    })
    protocol = clean(protocolAnswers.protocol)
    if (!protocol) return { saved: false, reason: "cancelled" }
    if (!base.isCustom) {
      const chosen = base.preset.protocols[protocol]
      if (chosen?.base_url) base.baseUrl = chosen.base_url
    }
  }

  const answers = await ask({ questions: detailQuestions(base, { existingNames }) })
  const name = sanitizeName(answers.name) || base.suggestedName
  if (!name) return { saved: false, reason: "cancelled" }
  const apiKey = clean(answers.api_key)

  const probeEntry = buildEntry({ base, protocol, answers, apiKey, model: "" })
  // Issue #3 在表单世界的形态：对已有 provider 重跑 add、key 留空时，模型发现
  // 要用配置里已有的内联 api_key —— 用户不该因为「没重打一遍密钥」而被降级到
  // 手动输入。只进发现的 draft，不写盘（写盘的 merge 语义本来就保留旧字段）。
  const existingKey = configState?.config?.provider?.[name]?.api_key
  if (!apiKey && typeof existingKey === "string" && existingKey) {
    probeEntry.api_key = existingKey
  }
  const model = await askModel({
    name,
    entry: probeEntry,
    defaultModel: base.preset?.default_model,
    ask,
    discover
  })
  if (!model) return { saved: false, reason: "cancelled" }

  const entry = buildEntry({ base, protocol, answers, apiKey, model })
  const confirm = await ask({
    questions: [{
      id: "confirm",
      header: "Confirm",
      text: `将写入 ~/.kkcode/config.yaml：\n\n${previewEntry(name, entry)}`,
      allowCustom: false,
      options: [
        { label: "保存", value: "save", description: "写入配置并切换到该 provider" },
        { label: "取消", value: "cancel", description: "不写任何东西" }
      ]
    }]
  })
  if (clean(confirm.confirm) !== "save") return { saved: false, reason: "cancelled" }

  const configPatch = { provider: { default: name, [name]: entry } }
  await saveProviderConfig(configPatch, true)
  return { saved: true, name, configPatch }
}

/**
 * `/provider edit <name>`：**有什么字段就显示什么字段**，不铺全量表。
 *
 * 每个字段的当前值预填进输入框，改完落盘；留空的 api_key 表示保留现有密钥
 * （表单里已提示）。要删除字段，直接编辑 YAML —— 表单不做「置空即删除」这种
 * 一不小心就丢配置的隐式语义。
 */
export async function runProviderEditForm({
  name,
  existing,
  ask = askQuestionInteractive
} = {}) {
  if (!name || !existing || typeof existing !== "object") {
    return { saved: false, reason: "not_found" }
  }

  const EDITABLE = ["type", "protocol", "base_url", "api_key_env", "default_model", "max_tokens", "context_limit"]
  const questions = EDITABLE
    .filter((key) => existing[key] !== undefined)
    .map((key) => ({
      id: key,
      header: key,
      text: `${key}（当前：${existing[key]}）`,
      default: String(existing[key])
    }))
  questions.push({
    id: "api_key",
    header: "API Key",
    text: existing.api_key
      ? `API Key（当前 ${maskKey(String(existing.api_key))}，留空保留）`
      : "API Key（当前未设置，留空跳过）",
    secret: true
  })

  const answers = await ask({ questions })
  const patch = {}
  for (const key of EDITABLE) {
    if (existing[key] === undefined) continue
    const value = clean(answers[key])
    if (!value || value === String(existing[key])) continue
    const numeric = ["max_tokens", "context_limit"].includes(key)
    patch[key] = numeric ? Number.parseInt(value, 10) : value
    if (numeric && !Number.isFinite(patch[key])) delete patch[key]
  }
  const newKey = clean(answers.api_key)
  if (newKey) patch.api_key = newKey

  if (!Object.keys(patch).length) return { saved: false, reason: "unchanged" }

  const configPatch = { provider: { [name]: { ...existing, ...patch } } }
  await saveProviderConfig(configPatch, false)
  return { saved: true, name, configPatch, changed: Object.keys(patch) }
}
