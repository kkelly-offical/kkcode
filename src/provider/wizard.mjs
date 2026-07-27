import path from "node:path"
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises"
import YAML from "yaml"
import { userRootDir } from "../storage/paths.mjs"

// --- 标准厂商预设 ---
export const VENDOR_PRESETS = {
  anthropic: {
    label: "Anthropic (Claude)",
    type: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-sonnet-4-6",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "ANTHROPIC_API_KEY"
  },
  openai: {
    label: "OpenAI (GPT)",
    type: "openai",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "OPENAI_API_KEY"
  },
  qwen: {
    label: "通义千问 Qwen (DashScope)",
    type: "openai-compatible",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen3.5-plus",
    models: ["qwen3.5-plus", "qwen3.5-flash", "qwen3-max", "qwen3-coder-plus", "qwen-plus-latest"],
    supports_thinking: true,
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
    models: ["qwen3.5-plus", "kimi-k2.6", "glm-5.1", "glm-5", "MiniMax-M2.5", "qwen3-coder-plus"],
    context_limit: 983616,
    supports_thinking: false,
    supports_vision: true,
    key_env: "CODING_PLAN_API_KEY"
  },
  glm: {
    label: "智谱 GLM",
    type: "openai-compatible",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-5.1",
    models: ["glm-5.1", "glm-5", "glm-4.5", "glm-4.5-air"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "ZHIPU_API_KEY"
  },
  deepseek: {
    label: "DeepSeek",
    type: "openai-compatible",
    base_url: "https://api.deepseek.com",
    default_model: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    supports_thinking: true,
    supports_vision: false,
    key_env: "DEEPSEEK_API_KEY"
  },
  gemini: {
    label: "Google Gemini",
    type: "openai-compatible",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
    default_model: "gemini-3.5-flash",
    models: ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-3.1-flash-lite"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "GEMINI_API_KEY"
  },
  kimi: {
    label: "Moonshot Kimi",
    type: "openai-compatible",
    base_url: "https://api.moonshot.ai/v1",
    default_model: "kimi-k2.6",
    models: ["kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k", "moonshot-v1-32k"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "MOONSHOT_API_KEY"
  },
  "kimi-code": {
    label: "Kimi Code (Coding API)",
    type: "openai-compatible",
    base_url: "https://api.kimi.com/coding/v1",
    default_model: "k3",
    models: ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
    context_limit: 1048576,
    supports_thinking: true,
    supports_vision: true,
    key_env: "KIMI_CODE_API_KEY"
  },
  xai: {
    label: "xAI Grok",
    type: "openai-compatible",
    base_url: "https://api.x.ai/v1",
    default_model: "grok-4.3",
    models: ["grok-4.3", "grok-4.3-latest"],
    supports_thinking: true,
    supports_vision: true,
    key_env: "XAI_API_KEY"
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

/**
 * 旧的十二步逐行问答状态机（createWizardState / handleWizardInput / 22 个 _step*）
 * 已在 0.7.3 删除，共 636 行。`/provider add` 与 `edit` 现在走 wizard-form.mjs
 * 的提问浮层表单 —— 状态机的每个步骤都要靠 print 与下一次回车接力，而那条
 * 输入路径要先穿过模式自动路由与 busy spinner；表单是模态的，问题在结构上消失。
 * 本文件只剩两样东西：厂商预设（表单的数据源）与写盘。
 */


/**
 * 写回 provider 配置：逐 provider 逐字段合并，未触及的字段（内联 api_key、
 * 超时调优、models 列表）原样保留。向导与 `kkcode provider` 命令共用 ——
 * 不要在别处再实现一份写回逻辑。
 */
export async function saveProviderConfig(newCfg, setDefault = true) {
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
  // 逐 provider 深合并：向导设置的字段生效，**没动的字段原样保留** ——
  // 0.5.0 之前这里是整条目替换，对已有 provider 重跑向导会把配置里的
  // 内联 api_key、timeout、models 列表等全部抹掉（issue #3 的姊妹问题）。
  for (const [key, value] of Object.entries(newCfg.provider)) {
    if (key === "default") continue
    existing.provider[key] = value && typeof value === "object"
      ? { ...(existing.provider[key] || {}), ...value }
      : value
  }
  if (setDefault && newCfg.provider.default) {
    existing.provider.default = newCfg.provider.default
  }

  await writeFile(configPath, YAML.stringify(existing), "utf8")
  // 配置文件从 0.7.3 起可能带明文 api_key。0600 在 POSIX 上挡住同机其它用户；
  // Windows 的 chmod 只动 readonly 位、不抛错，静默走过即可。
  try { await chmod(configPath, 0o600) } catch { /* 平台不支持就算了 */ }
}
