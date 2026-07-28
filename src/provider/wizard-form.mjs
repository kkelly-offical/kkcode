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
 * ## 0.8.0：去模板化 —— 「能自动读到的就不问」
 *
 * 0.7.x 的第一轮是 14 个厂商模板。用户的反馈是对的：模板是**我们**的知识，
 * 不是**用户**的输入 —— 用户真正拥有的只有三样东西：接口形式（OpenAI 还是
 * Anthropic 兼容）、base URL、密钥。其余一切都应该从 API 自己读回来：
 *
 *   - 模型列表      → GET /models（两种协议都有）
 *   - 上下文长度    → 目录条目的 context_length 等八种字段名（model-catalog）
 *   - thinking 支持 → supported_parameters 或模型名族启发式（thinking-effort）
 *
 * **只有读不到的才问**：目录没报上下文的模型追问一轮数字；能力判不出的模型
 * 追问一轮「支持/不支持/跳过」。名称从 URL host 推导，确认页上可改。
 *
 * ## 三条纪律（0.7.3 定下，继续有效）
 *
 * 1. **API Key 直接输入**，明文写进 `~/.kkcode/config.yaml` 的 `api_key`。
 *    输入时遮蔽（`secret: true`），确认页只显示末四位，不进对话记录与日志。
 * 2. **只写用户提供或确认过的字段**。自动读到的（上下文、thinking 支持）都在
 *    确认页逐条列出后才落盘 —— 自动发现不是背着用户写配置的许可。
 * 3. **确认页所见即所写**：预览里的每一行就是将要落盘的字段，没有背后追加。
 */

import { saveProviderConfig } from "./wizard.mjs"
import { discoverModelsForProvider } from "./model-catalog.mjs"
import { supportsThinking } from "./thinking-effort.mjs"
import { askQuestionInteractive } from "../tool/question-prompt.mjs"
import { QUESTION_SKIPPED } from "../repl/dialog-router.mjs"
import { PROVIDER_META_KEYS } from "../config/schema.mjs"

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

const sanitizeName = (raw) => clean(raw).replace(/[^a-z0-9_-]/gi, "_").toLowerCase()

/**
 * 从 base URL 推导 provider 名称。
 *
 * 规则：host 去掉 TLD 尾巴，从左往右取第一个**有语义**的标签 ——
 * `api.moonshot.ai` → moonshot、`llm-api.ecupl.edu.cn` → ecupl、
 * `open.bigmodel.cn` → bigmodel。IP 与 localhost 没有语义，退回 "local"。
 * 只是**建议值**：确认页上有「修改名称」，推错了不需要重走流程。
 */
export function suggestProviderName(baseUrl) {
  let host = ""
  try { host = new URL(String(baseUrl)).hostname } catch { return "" }
  if (!host) return ""
  if (host === "localhost" || /^[0-9.:[\]]+$/.test(host)) return "local"
  const TLDS = new Set([
    "com", "net", "org", "ai", "io", "cn", "co", "uk", "us", "jp",
    "edu", "gov", "dev", "app", "cloud", "tech", "xyz", "info"
  ])
  const parts = host.toLowerCase().split(".").filter(Boolean)
  while (parts.length > 1 && TLDS.has(parts[parts.length - 1])) parts.pop()
  // 「api.xxx」「www.xxx」里的前缀不是名字 —— 但整个 host 只剩它时也只能用它
  const GENERIC = new Set([
    "api", "www", "gateway", "open", "openapi", "llm", "llm-api",
    "platform", "console", "coding", "chat", "service", "services"
  ])
  const meaningful = parts.find((part) => !GENERIC.has(part))
  return sanitizeName(meaningful || parts[parts.length - 1] || "")
}

/** 轮 A：接口形式。用户拥有的三样输入之一 —— 这决定请求与鉴权的协议形状。 */
const PROTOCOL_CHOICES = [
  {
    label: "OpenAI 兼容接口",
    value: "openai",
    type: "openai-compatible",
    description: "chat/completions + Bearer 鉴权（OpenAI、DeepSeek、Kimi、Qwen、GLM、Ollama…）"
  },
  {
    label: "Anthropic 兼容接口",
    value: "anthropic",
    type: "anthropic",
    description: "messages + x-api-key 鉴权（Claude 及其兼容网关）"
  }
]

/** 用表单当前值拼一份临时 configState，让模型发现走与 /model 完全相同的链路。 */
function draftConfigState(name, entry) {
  const provider = { default: name, [name]: entry }
  return {
    config: { provider },
    source: { userRaw: { provider: { [name]: { ...entry } } }, projectRaw: {}, envOverlay: {} }
  }
}

const MANUAL_MODEL = "(manual input)"

/**
 * 发现结果归一成 `[{ id, contextLength, supportedParameters }]`；
 * 发现失败当「没有列表」，不是错误。
 *
 * 0.8.0 顺带修掉一个真缺陷：这里此前调的是 `discover(draft, name, {refresh})`，
 * 而 discoverModelsForProvider 的签名是 `(configState, options)` —— name 被当成
 * options 解构（字符串上什么都解不出来），`refresh: true` 整个丢失，表单的
 * 模型发现一直在吃 15 分钟的缓存。
 */
async function discoverModelChoices({ name, entry, discover }) {
  try {
    const result = await discover(draftConfigState(name, entry), { providerName: name, refresh: true })
    return (result?.models || [])
      .map((m) => (typeof m === "string" ? { id: m } : m))
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        // model-catalog 的 readContextLength 已经把各家字段名统一过，并且只在
        // >= 1024 时给值 —— 这里不再二次判断，也不为拿不到的模型编一个数字。
        contextLength: Number.isFinite(Number(m.contextLength)) ? Number(m.contextLength) : 0,
        supportedParameters: Array.isArray(m.supportedParameters) ? m.supportedParameters : null
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
 * 轮 C：选模型。发现成功给**多选**（全量列出 + 手动项），失败直接自由文本。
 * 发现失败不是错误 —— 本地服务、离线、密钥权限不足都会走到，手动输入永远可用。
 *
 * 0.8.0 起不再 slice(0, 30)：浮层有了滚动窗口与打字过滤（overlay-question），
 * 60 个模型的列表打几个字符就到 —— 截断反而是「第 31 个起根本看不见」的静默丢失。
 *
 * 选项标签带上下文（`gpt-4o (128k)`）：这正是用户挑模型时要比的那个数。
 *
 * @returns {Promise<{models: string[], defaultModel: string, contexts: Record<string, number>, discovered: Array}>}
 */
async function askModel({ name, entry, ask, discover }) {
  const discovered = await discoverModelChoices({ name, entry, discover })
  const empty = { models: [], defaultModel: "", contexts: {}, discovered }

  if (discovered.length) {
    const picked = await ask({
      questions: [{
        id: "model",
        header: "Models",
        text: `选择要加入配置的模型（空格多选、回车确认、打字过滤；发现 ${discovered.length} 个）`,
        allowCustom: false,
        multi: true,
        options: [
          ...discovered.map((m) => ({
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
      if (!chosenDefault) return { ...empty, cancelled: true }
      const contexts = {}
      // 发现不到上下文的模型**不写** —— 编一个数字会让压缩阈值静默算错；
      // 读不到的那几个由 askMissingContexts 追问，用户不答仍然不写
      for (const id of chosen) if (contextOf(id)) contexts[id] = contextOf(id)
      return { models: chosen, defaultModel: chosenDefault, contexts, discovered }
    }
  }

  const manual = await ask({
    questions: [{
      id: "model",
      header: "Model",
      text: "默认模型 ID（如 gpt-4o、claude-sonnet-4-5）",
      default: ""
    }]
  })
  const typed = clean(manual.model)
  return typed ? { models: [typed], defaultModel: typed, contexts: {}, discovered } : empty
}

/**
 * 目录没报上下文的模型，一轮补问。**这是「只有缺失信息才要用户动手」的落点**：
 * 读到了就一个字都不问，读不到的逐个给一格数字输入，留空 = 不写、运行时用
 * 内置缺省表 —— 与「不编数字」同一条纪律。
 */
async function askMissingContexts({ chosen, contexts, ask }) {
  const missing = chosen.filter((id) => !contexts[id])
  if (!missing.length) return {}
  const answers = await ask({
    questions: missing.map((id) => ({
      id: `ctx:${id}`,
      header: "Context",
      text: `${id} 的上下文长度（tokens）`,
      description: "API 目录没有报告这个模型的上下文。留空 = 不写入，运行时用内置缺省表。",
      default: ""
    }))
  })
  const out = {}
  for (const id of missing) {
    const n = Number.parseInt(clean(answers[`ctx:${id}`]), 10)
    if (Number.isFinite(n) && n >= 1024) out[id] = n
  }
  return out
}

/**
 * thinking 支持：能自动判的自动判，判不出的才问。
 *
 * 判据优先级与 supportsThinking 一致：目录报了 supported_parameters 以它为准
 * （OpenRouter 等会报），否则按模型名族启发式；两者都拿不准返回 null —— 那才
 * 轮到用户。结果进 `provider.model_thinking`（true/false 都记：知道「不支持」
 * 同样有价值，/model 据此不再对它弹 thinking 档位）。
 */
function detectThinkingSupport(chosen, discovered) {
  const byId = new Map(discovered.map((m) => [m.id, m]))
  const known = {}
  const unknown = []
  for (const id of chosen) {
    const meta = byId.get(id)
    const verdict = supportsThinking({ modelId: id, supportedParameters: meta?.supportedParameters ?? null })
    if (verdict === true || verdict === false) known[id] = verdict
    else unknown.push(id)
  }
  return { known, unknown }
}

async function askMissingThinking({ unknown, ask }) {
  if (!unknown.length) return {}
  const answers = await ask({
    questions: unknown.map((id) => ({
      id: `think:${id}`,
      header: "Thinking",
      text: `${id} 支持扩展思考（thinking / reasoning）吗？`,
      description: "目录没报能力、模型名也认不出。答了才写入 provider.model_thinking；跳过 = 不写。",
      allowCustom: false,
      options: [
        { label: "支持", value: "yes", description: "/model 选它之后会提供思考档位" },
        { label: "不支持", value: "no", description: "/model 不再问它的思考档位" },
        { label: "不确定（跳过）", value: "skip", description: "不写入配置" }
      ]
    }))
  })
  const out = {}
  for (const id of unknown) {
    const value = clean(answers[`think:${id}`])
    if (value === "yes") out[id] = true
    if (value === "no") out[id] = false
  }
  return out
}

/**
 * 组装将要写盘的条目。**这里出现的每个字段都来自用户的输入或确认页** ——
 * 旧向导在这一步塞过三样用户没答过的东西（preset 的 base_url、静默继承的
 * context_limit、硬编码的 budget_tokens: 8000），一样都不许再有。
 */
function buildEntry({ type, baseUrl, apiKey, model, models = [] }) {
  const entry = { type }
  if (baseUrl) entry.base_url = baseUrl
  if (apiKey) entry.api_key = apiKey
  if (model) entry.default_model = model
  // 选中的模型全部写进 models。除了「配置里有哪些模型可用」之外还有一层收益：
  // model-catalog 的 explicitOfflineModels 读的就是这个数组 —— 断网时 /model
  // 列出来的正是这几个，而不是空列表。
  if (models.length) entry.models = [...models]
  return entry
}

/**
 * 确认页文本：所见即所写。密钥只给末四位。
 *
 * `models` 逐行列出并跟上上下文（`gpt-4o (128k)` / `o3-mini (—)`）：`—` 表示
 * 这个模型的上下文没发现到、`provider.model_context` 里也就不会有它 ——
 * 用户在按下保存之前就该看见这个区别，而不是事后翻 YAML 才发现少了一半。
 */
export function previewEntry(name, entry, { setDefault = true, modelContext = {}, modelThinking = {} } = {}) {
  const lines = [`provider.${name}:`]
  for (const [key, value] of Object.entries(entry)) {
    if (key === "api_key") lines.push(`  api_key: ${maskKey(String(value))}（明文保存）`)
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
  const thinkingEntries = Object.entries(modelThinking)
  if (thinkingEntries.length) {
    lines.push("provider.model_thinking:")
    for (const [id, supported] of thinkingEntries) lines.push(`  ${id}: ${supported ? "支持" : "不支持"}`)
  }
  if (setDefault) lines.push(`provider.default: ${name}`)
  return lines.join("\n")
}

/**
 * `/provider add` 的入口（0.8.0 去模板化流程）。
 *
 * 轮次：接口形式 → base_url + api_key → 模型多选（自动发现）→（缺上下文才有的）
 * 补问 →（判不出 thinking 才有的）补问 → 确认（可改名）。
 *
 * @returns {Promise<{saved: boolean, name?: string, configPatch?: object, reason?: string}>}
 */
export async function runProviderAddForm({
  configState,
  ask = askQuestionInteractive,
  discover = discoverModelsForProvider
} = {}) {
  // provider 段里混着非 provider 的配置键（default / strict_mode / model_context /
  // model_thinking）。判据与 schema 的 PROVIDER_META_KEYS 同源 —— 0.7.3 版在这里
  // 手写过一份三个键的清单，加第四个键时它就会静默漏。
  const RESERVED = new Set(PROVIDER_META_KEYS)
  const providerBag = configState?.config?.provider || {}
  const existingNames = Object.keys(providerBag)
    .filter((k) => !RESERVED.has(k) && providerBag[k] && typeof providerBag[k] === "object")

  const protocolAnswers = await ask({
    questions: [{
      id: "protocol",
      header: "Protocol",
      text: "这个服务是什么形式的接口？",
      allowCustom: false,
      options: PROTOCOL_CHOICES.map(({ label, value, description }) => ({ label, value, description }))
    }]
  })
  const protocol = PROTOCOL_CHOICES.find((p) => p.value === clean(protocolAnswers.protocol))
  if (!protocol) return { saved: false, reason: "cancelled" }

  const connection = await ask({
    questions: [
      {
        id: "base_url",
        header: "Base URL",
        text: "API Base URL（模型列表、上下文、thinking 能力都将从它自动读取）",
        default: ""
      },
      {
        id: "api_key",
        header: "API Key",
        text: "API Key（输入时不回显，明文保存到 ~/.kkcode/config.yaml）",
        secret: true,
        description: "留空 = 不配置凭据（本地服务通常不需要）"
      }
    ]
  })
  const baseUrl = clean(connection.base_url).replace(/\/+$/, "")
  if (!baseUrl) return { saved: false, reason: "cancelled" }
  const apiKey = clean(connection.api_key)

  // 名称推导：同一个 base_url 已经配过 → 沿用那个名字（重配即合并更新，
  // issue #3 的语义在新流程里靠它保住）；否则从 host 推导，确认页可改。
  const sameUrl = existingNames.find((n) => {
    const configured = providerBag[n]?.base_url
    return typeof configured === "string" && configured.replace(/\/+$/, "") === baseUrl
  })
  let name = sameUrl || suggestProviderName(baseUrl) || "custom"
  if (RESERVED.has(name)) name = `${name}-provider`

  const probeEntry = buildEntry({ type: protocol.type, baseUrl, apiKey, model: "" })
  // 对已有 provider 重跑 add、key 留空时，模型发现要用配置里已有的内联 api_key ——
  // 用户不该因为「没重打一遍密钥」而被降级到手动输入。只进发现的 draft，不写盘
  // （写盘的 merge 语义本来就保留旧字段）。
  const existingKey = providerBag[name]?.api_key
  if (!apiKey && typeof existingKey === "string" && existingKey) {
    probeEntry.api_key = existingKey
  }

  const modelResult = await askModel({ name, entry: probeEntry, ask, discover })
  const { models, defaultModel: model, discovered } = modelResult
  if (!model) return { saved: false, reason: "cancelled" }

  const contexts = {
    ...modelResult.contexts,
    ...(await askMissingContexts({ chosen: models, contexts: modelResult.contexts, ask }))
  }
  const { known, unknown } = detectThinkingSupport(models, discovered)
  const thinkingMap = { ...known, ...(await askMissingThinking({ unknown, ask })) }

  const entry = buildEntry({ type: protocol.type, baseUrl, apiKey, model, models })

  // 确认循环：保存 / 修改名称 / 取消。名称是唯一推导出来（而非用户输入）的
  // 落盘键名，所以必须给一条不重走全流程的修改路径。
  for (;;) {
    const preview = previewEntry(name, entry, { modelContext: contexts, modelThinking: thinkingMap })
    const confirm = await ask({
      questions: [{
        id: "confirm",
        header: "Confirm",
        text: `将写入 ~/.kkcode/config.yaml：\n\n${preview}${
          models.length > 1 ? "\n\nmodels 里的每个模型都能用 /model 切换；断网时它也是可选清单。" : ""
        }`,
        description: existingNames.includes(name)
          ? `同名 provider「${name}」已存在：保存 = 合并更新，未触及的字段原样保留`
          : "",
        allowCustom: false,
        options: [
          { label: "保存", value: "save", description: "写入配置并切换到该 provider" },
          { label: "修改名称", value: "rename", description: `当前：${name}（从 URL 推导）` },
          { label: "取消", value: "cancel", description: "不写任何东西" }
        ]
      }]
    })
    const choice = clean(confirm.confirm)
    if (choice === "rename") {
      const renamed = await ask({
        questions: [{
          id: "name",
          header: "Name",
          text: "Provider 名称（写进配置的键名，小写字母/数字/-/_）",
          default: name
        }]
      })
      const nextName = sanitizeName(renamed.name)
      if (nextName && !RESERVED.has(nextName)) name = nextName
      continue
    }
    if (choice !== "save") return { saved: false, reason: "cancelled" }
    break
  }

  const configPatch = { provider: { default: name, [name]: entry } }
  // model_context / model_thinking 是 provider 段下的顶层 map（不是条目内字段）。
  // saveProviderConfig 对它们走同一套浅合并 —— 新模型的条目并进去，别的原样留着。
  if (Object.keys(contexts).length) configPatch.provider.model_context = { ...contexts }
  if (Object.keys(thinkingMap).length) configPatch.provider.model_thinking = { ...thinkingMap }
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
