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
    thinking: false
  }
}

// --- 启动向导 ---
export function startWizard(wiz, print) {
  Object.assign(wiz, createWizardState())
  wiz.active = true
  wiz.step = "vendor"
  print(buildVendorMenu())
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
    case "custom_name": return _stepCustomName(wiz, val, print)
    case "custom_url": return _stepCustomUrl(wiz, val, print)
    case "apikey": return _stepApiKey(wiz, val, print)
    case "model": return _stepModel(wiz, val, print)
    case "context": return _stepContext(wiz, val, print)
    case "thinking": return _stepThinking(wiz, val, print)
    case "confirm": return _stepConfirm(wiz, val, print)
    default:
      wiz.active = false
      return { done: true, cancelled: true }
  }
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
    if (wiz.preset.type === "ollama") {
      wiz.step = "model"
      print(`\n  默认模型 [${wiz.defaultModel}]（回车使用默认，或输入模型名）：`)
    } else {
      wiz.step = "apikey"
      print(`\n  输入 API Key（回车跳过，使用环境变量 ${wiz.preset.key_env}）：`)
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
  print("\n  输入 API Key（回车跳过）：")
  return { done: false }
}

function _stepApiKey(wiz, val, print) {
  wiz.apiKey = val || null
  wiz.step = "model"
  const defModel = wiz.preset?.default_model || ""
  print(`\n  默认模型${defModel ? ` [${defModel}]` : ""}（回车使用默认）：`)
  return { done: false }
}

function _stepModel(wiz, val, print) {
  wiz.defaultModel = val || wiz.preset?.default_model || ""
  wiz.step = "context"
  print("\n  上下文长度（tokens，如 32768，回车跳过）：")
  return { done: false }
}

function _stepContext(wiz, val, print) {
  if (val) {
    const n = parseInt(val, 10)
    if (isNaN(n) || n < 1024) {
      print("  请输入有效整数（>= 1024），或回车跳过：")
      return { done: false }
    }
    wiz.contextLimit = n
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
  print(`\n  已保存 provider "${name}" 到 ~/.kkcode/config.yaml`)
  print(`  重启 kkcode 后生效，或使用 /provider ${name} 切换（需重启加载配置）。`)
  return { done: true, cancelled: false, providerName: name }
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
    if (preset.type !== "openai" && preset.type !== "anthropic" && preset.type !== "ollama") {
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

async function _saveProviderConfig(newCfg) {
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
  existing.provider.default = newCfg.provider.default

  await writeFile(configPath, YAML.stringify(existing), "utf8")
}
