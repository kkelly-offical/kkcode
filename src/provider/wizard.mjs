import path from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import YAML from "yaml"
import { userRootDir } from "../storage/paths.mjs"

// --- 标准厂商预设 ---
export const VENDOR_PRESETS = {
  anthropic: {
    label: "Anthropic (Claude)",
    type: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-opus-4-6",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "ANTHROPIC_API_KEY"
  },
  openai: {
    label: "OpenAI (GPT)",
    type: "openai",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    supports_thinking: false,
    supports_vision: true,
    key_env: "OPENAI_API_KEY"
  },
  qwen: {
    label: "通义千问 Qwen (DashScope)",
    type: "openai-compatible",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen-max",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-coder-plus"],
    supports_thinking: false,
    supports_vision: true,
    key_env: "DASHSCOPE_API_KEY"
  },
  "coding-plan": {
    label: "Coding Plan (阿里云百炼)",
    protocols: {
      openai: {
        type: "openai-compatible",
        base_url: "https://coding.dashscope.aliyuncs.com/v1"
      },
      anthropic: {
        type: "anthropic",
        base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic"
      }
    },
    default_model: "qwen3.5-plus",
    models: ["qwen3.5-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3-coder-next", "qwen3-coder-plus", "glm-4.7"],
    context_limit: 983616,
    supports_thinking: false,
    supports_vision: true,
    key_env: "CODING_PLAN_API_KEY"
  },
  glm: {
    label: "智谱 GLM",
    type: "openai-compatible",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-4-plus",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    supports_thinking: false,
    supports_vision: true,
    key_env: "ZHIPU_API_KEY"
  },
  deepseek: {
    label: "DeepSeek",
    type: "openai-compatible",
    base_url: "https://api.deepseek.com",
    default_model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    supports_thinking: true,
    supports_vision: false,
    key_env: "DEEPSEEK_API_KEY"
  },
  ollama: {
    label: "Ollama (本地，无需 API Key)",
    type: "ollama",
    base_url: "http://localhost:11434",
    default_model: "qwen3",
    models: ["qwen3", "deepseek-coder", "llama3.1"],
    supports_thinking: false,
    supports_vision: false,
    key_env: ""
  }
}

const VENDOR_KEYS = Object.keys(VENDOR_PRESETS)

// --- 编辑模式的可配置字段 ---
const EDIT_FIELDS = [
  { key: "type",            label: "Provider 类型",        type: "provider_type" },
  { key: "base_url",        label: "Base URL",             type: "string" },
  { key: "api_key",         label: "API Key",              type: "secret" },
  { key: "default_model",   label: "默认模型",             type: "string" },
  { key: "max_tokens",      label: "最大输出长度 (tokens)", type: "int", min: 1 },
  { key: "context_limit",   label: "上下文长度 (tokens)",   type: "int", min: 1024 },
  { key: "thinking",        label: "Thinking 模式",        type: "thinking" },
]

// --- 向导状态 ---
export function createWizardState() {
  return {
    active: false,
    step: "vendor",
    vendorKey: null,
    preset: null,
    isCustom: false,
    customName: null,
    customBaseUrl: null,
    customType: null,
    apiKey: null,
    defaultModel: null,
    contextLimit: null,
    thinking: false,
    // edit 模式
    editMode: false,
    editName: null,
    editConfig: null,
    editFieldIdx: 0,
    editChanges: {}
  }
}

// --- 启动向导 ---
export function startWizard(wiz, print) {
  Object.assign(wiz, createWizardState())
  wiz.active = true
  wiz.step = "vendor"
  print(buildVendorMenu())
}

// --- 启动编辑向导 ---
export function startEditWizard(wiz, name, existingCfg, print) {
  Object.assign(wiz, createWizardState())
  wiz.active = true
  wiz.editMode = true
  wiz.editName = name
  wiz.editConfig = { ...existingCfg }
  wiz.editFieldIdx = 0
  wiz.editChanges = {}
  wiz.step = "edit_field"
  _printEditHeader(wiz, print)
  _promptEditField(wiz, print)
}

function _printEditHeader(wiz, print) {
  const cfg = wiz.editConfig
  const keyDisplay = cfg.api_key ? cfg.api_key.slice(0, 8) + "..." : cfg.api_key_env ? `(env: ${cfg.api_key_env})` : "(未设置)"
  const thinkingDisplay = cfg.thinking?.type === "enabled" ? `启用 (budget: ${cfg.thinking.budget_tokens || "默认"})` : "关闭"
  const lines = [
    "",
    `  ── 编辑 Provider: ${wiz.editName} ──`,
    "",
    `    type:          ${cfg.type || wiz.editName}`,
    `    base_url:      ${cfg.base_url || "(未设置)"}`,
    `    api_key:       ${keyDisplay}`,
    `    default_model: ${cfg.default_model || "(未设置)"}`,
    `    max_tokens:    ${cfg.max_tokens || "(默认 16384)"}`,
    `    context_limit: ${cfg.context_limit || "(未设置)"}`,
    `    thinking:      ${thinkingDisplay}`,
    "",
    "  逐项修改（输入 0 保留原值，输入新值覆盖，q 取消）：",
    ""
  ]
  print(lines.join("\n"))
}

function _promptEditField(wiz, print) {
  const field = EDIT_FIELDS[wiz.editFieldIdx]
  if (!field) return
  const cfg = wiz.editConfig
  let current
  if (field.type === "secret") {
    current = cfg[field.key] ? cfg[field.key].slice(0, 8) + "..." : "(未设置)"
  } else if (field.type === "thinking") {
    current = cfg.thinking?.type === "enabled"
      ? `启用 (budget: ${cfg.thinking.budget_tokens || "默认"})`
      : "关闭"
  } else if (field.type === "provider_type") {
    current = cfg[field.key] || wiz.editName
    print(`  ${field.label} [${current}]（可选: openai-compatible, anthropic, openai, ollama；0=保留）：`)
    return
  } else {
    current = cfg[field.key] ?? "(未设置)"
  }
  print(`  ${field.label} [${current}]（0=保留）：`)
}

function buildVendorMenu() {
  const lines = ["", "  ── 配置 Provider ──", ""]
  VENDOR_KEYS.forEach((k, i) => {
    lines.push(`  ${i + 1}. ${VENDOR_PRESETS[k].label}`)
  })
  const base = VENDOR_KEYS.length
  lines.push(`  ${base + 1}. 自定义 OpenAI 兼容 API`)
  lines.push(`  ${base + 2}. 自定义 Anthropic 兼容 API`)
  lines.push("")
  lines.push("  输入编号（q 取消）：")
  return lines.join("\n")
}

// --- 处理向导输入，返回 { done, cancelled, providerName } ---
export async function handleWizardInput(wiz, input, print) {
  const val = String(input || "").trim()

  if (val.toLowerCase() === "q" || val.toLowerCase() === "quit") {
    wiz.active = false
    print("已取消 provider 配置。")
    return { done: true, cancelled: true }
  }

  switch (wiz.step) {
    case "vendor": return _stepVendor(wiz, val, print)
    case "protocol": return _stepProtocol(wiz, val, print)
    case "custom_name": return _stepCustomName(wiz, val, print)
    case "custom_url": return _stepCustomUrl(wiz, val, print)
    case "apikey": return _stepApiKey(wiz, val, print)
    case "model": return _stepModel(wiz, val, print)
    case "context": return _stepContext(wiz, val, print)
    case "thinking": return _stepThinking(wiz, val, print)
    case "confirm": return _stepConfirm(wiz, val, print)
    case "edit_field": return _stepEditField(wiz, val, print)
    case "edit_thinking_budget": return _stepEditThinkingBudget(wiz, val, print)
    case "edit_confirm": return _stepEditConfirm(wiz, val, print)
    default:
      wiz.active = false
      return { done: true, cancelled: true }
  }
}

function _stepProtocol(wiz, val, print) {
  const protoKeys = Object.keys(wiz.preset.protocols)
  const idx = parseInt(val, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= protoKeys.length) {
    print(`  请输入 1-${protoKeys.length} 之间的编号：`)
    return { done: false }
  }
  const chosen = wiz.preset.protocols[protoKeys[idx]]
  // 将选中的协议信息写入 preset（覆盖 type / base_url）
  wiz.preset = { ...wiz.preset, type: chosen.type, base_url: chosen.base_url }
  wiz.step = "apikey"
  print(`\n  输入 Coding Plan 专属 API Key（sk-sp-xxx，0=跳过使用环境变量 ${wiz.preset.key_env}）：`)
  return { done: false }
}

function _stepVendor(wiz, val, print) {

  const total = VENDOR_KEYS.length
  const idx = parseInt(val, 10) - 1
  if (isNaN(idx) || idx < 0 || idx > total + 1) {
    print(`  请输入 1-${total + 2} 之间的编号：`)
    return { done: false }
  }
  if (idx < total) {
    wiz.vendorKey = VENDOR_KEYS[idx]
    wiz.preset = VENDOR_PRESETS[wiz.vendorKey]
    wiz.defaultModel = wiz.preset.default_model
    if (wiz.preset.protocols) {
      wiz.step = "protocol"
      const protoKeys = Object.keys(wiz.preset.protocols)
      const lines = ["\n  选择 API 协议："]
      protoKeys.forEach((k, i) => {
        const p = wiz.preset.protocols[k]
        lines.push(`  ${i + 1}. ${k} 兼容 (${p.base_url})`)
      })
      lines.push("", "  输入编号：")
      print(lines.join("\n"))
    } else if (wiz.preset.type === "ollama") {
      wiz.step = "model"
      print(`\n  默认模型 [${wiz.defaultModel}]（0=使用默认，或输入模型名）：`)
    } else {
      wiz.step = "apikey"
      print(`\n  输入 API Key（0=跳过，使用环境变量 ${wiz.preset.key_env}）：`)
    }
  } else if (idx === total) {
    wiz.isCustom = true
    wiz.customType = "openai-compatible"
    wiz.step = "custom_name"
    print("\n  自定义 Provider 名称（如 moonshot、kimi）：")
  } else {
    wiz.isCustom = true
    wiz.customType = "anthropic"
    wiz.step = "custom_name"
    print("\n  自定义 Provider 名称（如 my-claude）：")
  }
  return { done: false }
}

function _stepCustomName(wiz, val, print) {
  if (!val) { print("  名称不能为空："); return { done: false } }
  wiz.customName = val.replace(/[^a-z0-9_-]/gi, "_").toLowerCase()
  wiz.step = "custom_url"
  print("\n  Base URL（如 https://api.example.com/v1）：")
  return { done: false }
}

function _stepCustomUrl(wiz, val, print) {
  if (!val || !val.startsWith("http")) {
    print("  请输入有效 URL（以 http 开头）：")
    return { done: false }
  }
  wiz.customBaseUrl = val
  wiz.step = "apikey"
  print("\n  输入 API Key（0=跳过）：")
  return { done: false }
}

function _stepApiKey(wiz, val, print) {
  wiz.apiKey = (val && val !== "0") ? val : null
  wiz.step = "model"
  const defModel = wiz.preset?.default_model || ""
  print(`\n  默认模型${defModel ? ` [${defModel}]` : ""}（0=使用默认）：`)
  return { done: false }
}

function _stepModel(wiz, val, print) {
  wiz.defaultModel = (val && val !== "0") ? val : (wiz.preset?.default_model || "")
  wiz.step = "context"
  const ctxHint = wiz.preset?.context_limit ? ` [${wiz.preset.context_limit}]` : ""
  print(`\n  上下文长度（tokens，如 32768，0=使用默认${ctxHint}）：`)
  return { done: false }
}

function _stepContext(wiz, val, print) {
  if (val && val !== "0") {
    const n = parseInt(val, 10)
    if (isNaN(n) || n < 1024) {
      print("  请输入有效整数（>= 1024），或输入 0 跳过：")
      return { done: false }
    }
    wiz.contextLimit = n
  } else if (wiz.preset?.context_limit) {
    wiz.contextLimit = wiz.preset.context_limit
  }
  const supportsThinking = wiz.preset?.supports_thinking || false
  if (supportsThinking) {
    wiz.step = "thinking"
    print("\n  启用 thinking 模式？(y/N)：")
  } else {
    wiz.step = "confirm"
    print(_buildConfirmPrompt(wiz))
  }
  return { done: false }
}

function _stepThinking(wiz, val, print) {
  wiz.thinking = val.toLowerCase() === "y" || val.toLowerCase() === "yes"
  wiz.step = "confirm"
  print(_buildConfirmPrompt(wiz))
  return { done: false }
}

async function _stepConfirm(wiz, val, print) {
  if (val.toLowerCase() === "n" || val.toLowerCase() === "no") {
    wiz.active = false
    print("已取消。")
    return { done: true, cancelled: true }
  }
  const cfg = _buildProviderConfig(wiz)
  const name = wiz.customName || wiz.vendorKey
  await _saveProviderConfig(cfg)
  wiz.active = false
  print(`\n  已保存 provider "${name}" 到 ~/.kkcode/config.yaml，已生效。`)
  return { done: true, cancelled: false, providerName: name, configPatch: cfg }
}

function _buildConfirmPrompt(wiz) {
  const name = wiz.customName || wiz.vendorKey
  const keyDisplay = wiz.apiKey ? wiz.apiKey.slice(0, 8) + "..." : "(使用环境变量)"
  const lines = [
    "",
    "  配置摘要：",
    `    名称:     ${name}`,
    `    类型:     ${wiz.preset?.type || wiz.customType}`,
    `    Base URL: ${wiz.preset?.base_url || wiz.customBaseUrl}`,
    `    API Key:  ${keyDisplay}`,
    `    模型:     ${wiz.defaultModel || "(未设置)"}`,
    `    上下文:   ${wiz.contextLimit ? wiz.contextLimit + " tokens" : "(默认)"}`,
    wiz.thinking ? "    Thinking: 启用" : null,
    "",
    "  保存到 ~/.kkcode/config.yaml？(Y/n)："
  ].filter(Boolean)
  return lines.join("\n")
}

function _buildProviderConfig(wiz) {
  const name = wiz.customName || wiz.vendorKey
  const preset = wiz.preset
  const entry = {}

  if (wiz.isCustom) {
    entry.type = wiz.customType
    entry.base_url = wiz.customBaseUrl
  } else {
    // 内置 openai/anthropic/ollama 不需要 type 字段（直接用 key 名匹配）
    // 但 Coding Plan 等带 protocols 的 preset 必须显式指定 type
    const needExplicitType = preset.type !== "openai" && preset.type !== "anthropic" && preset.type !== "ollama"
    const hasProtocols = VENDOR_PRESETS[wiz.vendorKey]?.protocols
    if (needExplicitType || hasProtocols) {
      entry.type = preset.type
    }
    entry.base_url = preset.base_url
  }

  if (wiz.apiKey) entry.api_key = wiz.apiKey
  if (wiz.defaultModel) entry.default_model = wiz.defaultModel
  if (wiz.contextLimit) entry.context_limit = wiz.contextLimit
  if (wiz.thinking) entry.thinking = { type: "enabled", budget_tokens: 8000 }

  return { provider: { default: name, [name]: entry } }
}

function _stepEditField(wiz, val, print) {
  const field = EDIT_FIELDS[wiz.editFieldIdx]
  if (val && val !== "0") {
    if (field.type === "provider_type") {
      const valid = ["openai", "openai-compatible", "anthropic", "ollama"]
      if (!valid.includes(val)) {
        print(`  无效类型，可选: ${valid.join(", ")}；输入 0 保留：`)
        return { done: false }
      }
      wiz.editChanges[field.key] = val
    } else if (field.type === "int") {
      const n = parseInt(val, 10)
      if (isNaN(n) || (field.min && n < field.min)) {
        print(`  请输入有效整数${field.min ? ` (>= ${field.min})` : ""}，或输入 0 跳过：`)
        return { done: false }
      }
      wiz.editChanges[field.key] = n
    } else if (field.type === "thinking") {
      const yes = val.toLowerCase() === "y" || val.toLowerCase() === "yes"
      if (yes) {
        // 继续问 budget
        wiz.step = "edit_thinking_budget"
        const cur = wiz.editConfig.thinking?.budget_tokens
        print(`  thinking budget_tokens [${cur || 10000}]（0=保留）：`)
        return { done: false }
      } else {
        wiz.editChanges.thinking = null
      }
    } else {
      wiz.editChanges[field.key] = val
    }
  }
  // 下一个字段
  wiz.editFieldIdx++
  if (wiz.editFieldIdx >= EDIT_FIELDS.length) {
    wiz.step = "edit_confirm"
    _printEditSummary(wiz, print)
    return { done: false }
  }
  _promptEditField(wiz, print)
  return { done: false }
}

function _stepEditThinkingBudget(wiz, val, print) {
  if (val === "0") val = ""
  const budget = val ? parseInt(val, 10) : (wiz.editConfig.thinking?.budget_tokens || 10000)
  if (val && (isNaN(budget) || budget < 0)) {
    print("  请输入有效整数 (>= 0)，或输入 0 保留：")
    return { done: false }
  }
  wiz.editChanges.thinking = { type: "enabled", budget_tokens: budget }
  wiz.editFieldIdx++
  if (wiz.editFieldIdx >= EDIT_FIELDS.length) {
    wiz.step = "edit_confirm"
    _printEditSummary(wiz, print)
    return { done: false }
  }
  wiz.step = "edit_field"
  _promptEditField(wiz, print)
  return { done: false }
}

function _printEditSummary(wiz, print) {
  const keys = Object.keys(wiz.editChanges)
  if (!keys.length) {
    print("\n  未做任何修改。")
    wiz.active = false
    return
  }
  const lines = ["", "  修改摘要："]
  for (const k of keys) {
    const v = wiz.editChanges[k]
    if (k === "api_key" && v) {
      lines.push(`    ${k}: ${v.slice(0, 8)}...`)
    } else if (k === "thinking") {
      lines.push(`    ${k}: ${v ? `启用 (budget: ${v.budget_tokens})` : "关闭"}`)
    } else {
      lines.push(`    ${k}: ${v}`)
    }
  }
  lines.push("", "  保存修改？(Y/n)：")
  print(lines.join("\n"))
}

async function _stepEditConfirm(wiz, val, print) {
  if (val.toLowerCase() === "n" || val.toLowerCase() === "no") {
    wiz.active = false
    print("已取消。")
    return { done: true, cancelled: true }
  }
  // 合并修改到已有配置并保存
  const merged = { ...wiz.editConfig }
  for (const [k, v] of Object.entries(wiz.editChanges)) {
    if (v === null) {
      delete merged[k]
    } else {
      merged[k] = v
    }
  }
  const saveCfg = { provider: { [wiz.editName]: merged } }
  await _saveProviderConfig(saveCfg, false)
  wiz.active = false
  print(`\n  已更新 provider "${wiz.editName}" 到 ~/.kkcode/config.yaml，已生效。`)
  return { done: true, cancelled: false, providerName: wiz.editName, configPatch: saveCfg }
}

async function _saveProviderConfig(newCfg, setDefault = true) {
  const configPath = path.join(userRootDir(), "config.yaml")
  await mkdir(path.dirname(configPath), { recursive: true })

  let existing = {}
  try {
    const raw = await readFile(configPath, "utf8")
    existing = YAML.parse(raw) || {}
  } catch {
    // 文件不存在，从空对象开始
  }

  if (!existing.provider) existing.provider = {}
  // 合并 provider 配置，保留已有的其他 provider
  Object.assign(existing.provider, newCfg.provider)
  if (setDefault && newCfg.provider.default) {
    existing.provider.default = newCfg.provider.default
  }

  await writeFile(configPath, YAML.stringify(existing), "utf8")
}
