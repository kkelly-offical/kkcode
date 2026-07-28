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

/**
 * 多选题的答案 → 值数组。
 *
 * 浮层把多选结果拼成 `"a, b, c"` 交回来（dialog-router 的 commitQuestionAnswer），
 * 所以这里按逗号拆。readline 降级路径**不支持多选**，回来的是单个值 —— 拆完
 * 正好是一个元素，同一段代码两边都对。
 */
const parseSelection = (value) => {
  const text = clean(value)
  if (!text) return []
  return [...new Set(text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean))]
}

const maskKey = (key) => (key.length > 4 ? `…${key.slice(-4)}` : "…set")

/**
 * 上下文长度 → 短标签：128000 → `128k`，1048576 → `1m`，拿不到 → `—`。
 *
 * 按十进制而不是 1024 换算：这个数字是给人看的，而各家标称的「128k」本来就是
 * 十进制口径。**不做「凑整到最近的漂亮数字」** —— 显示的必须是 API 真报的值，
 * 否则确认页就不再是所见即所写。
 */
export function formatContext(tokens) {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n < 1024) return "—"
  if (n >= 1000000) return `${(Math.round(n / 100000) / 10).toString().replace(/\.0$/, "")}m`
  return `${Math.round(n / 1000)}k`
}

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

const MANUAL_MODEL = "(manual input)"

/** 发现结果归一成 `[{ id, contextLength }]`；发现失败当「没有列表」，不是错误。 */
async function discoverModelChoices({ name, entry, discover }) {
  try {
    const result = await discover(draftConfigState(name, entry), name, { refresh: true })
    return (result?.models || [])
      .map((m) => (typeof m === "string" ? { id: m } : m))
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        // model-catalog 的 readContextLength 已经把各家字段名统一过，并且只在
        // >= 1024 时给值 —— 这里不再二次判断，也不为拿不到的模型编一个数字。
        contextLength: Number.isFinite(Number(m.contextLength)) ? Number(m.contextLength) : 0
      }))
  } catch {
    return []
  }
}

const labelWithContext = (id, contextLength) => `${id} (${formatContext(contextLength)})`

/**
 * 多选之后追问默认模型。**不悄悄拿第一个** —— 那是背着用户做决定，而默认模型
 * 是每次对话真正用到的那个。答案不在候选里（非交互的空答案也在内）一律当取消。
 */
async function askDefaultModel({ chosen, contextOf, ask }) {
  const answers = await ask({
    questions: [{
      id: "default_model",
      header: "Default",
      text: `哪个作为默认模型？（已选 ${chosen.length} 个，其余仍写进配置备用）`,
      allowCustom: false,
      options: chosen.map((id) => ({ label: labelWithContext(id, contextOf(id)), value: id, description: "" }))
    }]
  })
  const picked = clean(answers.default_model)
  return chosen.includes(picked) ? picked : ""
}

/**
 * 轮 D：选模型。发现成功给**多选**（前 30 个 + 手动），失败直接自由文本。
 * 发现失败不是错误 —— 本地服务、离线、密钥权限不足都会走到，手动输入永远可用。
 *
 * 选项标签带上下文（`gpt-4o (128k)`）：这正是用户挑模型时要比的那个数，而在
 * 0.7.4 之前它只能事后人肉查文档再手填 provider.model_context。
 *
 * @returns {Promise<{models: string[], defaultModel: string, contexts: Record<string, number>}>}
 */
async function askModel({ name, entry, defaultModel, ask, discover }) {
  const discovered = await discoverModelChoices({ name, entry, discover })
  const empty = { models: [], defaultModel: "", contexts: {} }

  if (discovered.length) {
    const picked = await ask({
      questions: [{
        id: "model",
        header: "Models",
        text: `选择要加入配置的模型（空格多选、回车确认；发现 ${discovered.length} 个）`,
        allowCustom: false,
        multi: true,
        options: [
          ...discovered.slice(0, 30).map((m) => ({
            label: labelWithContext(m.id, m.contextLength),
            value: m.id,
            description: m.contextLength ? `上下文 ${m.contextLength} tokens（写入 provider.model_context）` : ""
          })),
          { label: MANUAL_MODEL, value: MANUAL_MODEL, description: "手动输入模型 ID" }
        ]
      }]
    })
    // 手动项和真模型一起选中时以真模型为准：那一项的意思是「列表里没有我要的」，
    // 而列表里已经选出了东西
    const chosen = parseSelection(picked.model).filter((id) => id !== MANUAL_MODEL)
    if (chosen.length) {
      const byId = new Map(discovered.map((m) => [m.id, m.contextLength]))
      const contextOf = (id) => byId.get(id) || 0
      const chosenDefault = chosen.length === 1
        ? chosen[0]
        : await askDefaultModel({ chosen, contextOf, ask })
      if (!chosenDefault) return empty
      const contexts = {}
      // 发现不到上下文的模型**不写** —— 编一个数字会让压缩阈值静默算错，
      // 而运行时本来就有兜底表
      for (const id of chosen) if (contextOf(id)) contexts[id] = contextOf(id)
      return { models: chosen, defaultModel: chosenDefault, contexts }
    }
  }

  const manual = await ask({
    questions: [{
      id: "model",
      header: "Model",
      text: "默认模型 ID（如 gpt-4o、claude-sonnet-4-5）",
      default: defaultModel || ""
    }]
  })
  const typed = clean(manual.model)
  return typed ? { models: [typed], defaultModel: typed, contexts: {} } : empty
}

/**
 * 组装将要写盘的条目。**这里出现的每个字段都来自用户的输入或确认** ——
 * 旧向导在这一步塞过三样用户没答过的东西（preset 的 base_url、静默继承的
 * context_limit、硬编码的 budget_tokens: 8000），一样都不许再有。
 */
function buildEntry({ base, protocol, answers, apiKey, model, models = [] }) {
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
  // 选中的模型全部写进 models。除了「配置里有哪些模型可用」之外还有一层收益：
  // model-catalog 的 explicitOfflineModels 读的就是这个数组 —— 断网时 /model
  // 列出来的正是这几个，而不是空列表。
  if (models.length) entry.models = [...models]
  const contextLimit = Number.parseInt(clean(answers.context_limit), 10)
  if (Number.isFinite(contextLimit) && contextLimit >= 1024) entry.context_limit = contextLimit
  if (clean(answers.thinking) === "enabled") entry.thinking = { type: "enabled" }
  return entry
}

/**
 * 确认页文本：所见即所写。密钥只给末四位。
 *
 * `models` 逐行列出并跟上上下文（`gpt-4o (128k)` / `o3-mini (—)`）：`—` 表示
 * 这个模型的上下文没发现到、`provider.model_context` 里也就不会有它 ——
 * 用户在按下保存之前就该看见这个区别，而不是事后翻 YAML 才发现少了一半。
 */
export function previewEntry(name, entry, { setDefault = true, modelContext = {} } = {}) {
  const lines = [`provider.${name}:`]
  for (const [key, value] of Object.entries(entry)) {
    if (key === "api_key") lines.push(`  api_key: ${maskKey(String(value))}（明文保存）`)
    else if (key === "thinking") lines.push("  thinking: { type: enabled }")
    else if (key === "models" && Array.isArray(value)) {
      lines.push("  models:")
      for (const id of value) lines.push(`    - ${labelWithContext(id, modelContext[id])}`)
    } else lines.push(`  ${key}: ${value}`)
  }
  const contextEntries = Object.entries(modelContext)
  if (contextEntries.length) {
    lines.push("provider.model_context:")
    for (const [id, tokens] of contextEntries) lines.push(`  ${id}: ${tokens}`)
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
  const { models, defaultModel: model, contexts } = await askModel({
    name,
    entry: probeEntry,
    defaultModel: base.preset?.default_model,
    ask,
    discover
  })
  if (!model) return { saved: false, reason: "cancelled" }

  const entry = buildEntry({ base, protocol, answers, apiKey, model, models })
  const preview = previewEntry(name, entry, { modelContext: contexts })
  const confirm = await ask({
    questions: [{
      id: "confirm",
      header: "Confirm",
      text: `将写入 ~/.kkcode/config.yaml：\n\n${preview}${
        models.length > 1 ? "\n\nmodels 里的每个模型都能用 /model 切换；断网时它也是可选清单。" : ""
      }`,
      allowCustom: false,
      options: [
        { label: "保存", value: "save", description: "写入配置并切换到该 provider" },
        { label: "取消", value: "cancel", description: "不写任何东西" }
      ]
    }]
  })
  if (clean(confirm.confirm) !== "save") return { saved: false, reason: "cancelled" }

  const configPatch = { provider: { default: name, [name]: entry } }
  // model_context 是 provider 段下的顶层 map（不是条目内字段）。saveProviderConfig
  // 对它走的是同一套浅合并 —— 新模型的上下文并进去，别的模型的原样留着。
  if (Object.keys(contexts).length) configPatch.provider.model_context = { ...contexts }
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
