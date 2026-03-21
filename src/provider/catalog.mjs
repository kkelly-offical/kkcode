function defineProvider(id, spec) {
  return {
    id,
    label: spec.label || id,
    type: spec.type || id,
    base_url: spec.base_url || "",
    default_model: spec.default_model || "",
    models: Array.isArray(spec.models) ? [...spec.models] : [],
    key_env: spec.key_env || "",
    headers: spec.headers ? { ...spec.headers } : undefined,
    supports_thinking: spec.supports_thinking === true,
    supports_vision: spec.supports_vision === true,
    auth_modes: Array.isArray(spec.auth_modes) ? [...spec.auth_modes] : ["api_key"],
    supports_oauth: spec.supports_oauth === true,
    oauth_flow: spec.oauth_flow || "browser",
    auth_docs_url: spec.auth_docs_url || "",
    oauth_authorize_url: spec.oauth_authorize_url || "",
    oauth_token_url: spec.oauth_token_url || "",
    oauth_client_id: spec.oauth_client_id || "",
    oauth_scopes: Array.isArray(spec.oauth_scopes) ? [...spec.oauth_scopes] : [],
    context_limit: spec.context_limit ?? null,
    include_in_defaults: spec.include_in_defaults !== false,
    include_in_init: spec.include_in_init !== false,
    include_in_wizard: spec.include_in_wizard !== false,
    protocols: spec.protocols ? structuredClone(spec.protocols) : undefined
  }
}

export const PROVIDER_CATALOG = {
  anthropic: defineProvider("anthropic", {
    label: "Anthropic (Claude)",
    type: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-opus-4-6",
    models: ["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-6"],
    key_env: "ANTHROPIC_API_KEY",
    supports_thinking: true,
    supports_vision: true,
    auth_modes: ["api_key", "oauth", "token"],
    supports_oauth: true
  }),
  openai: defineProvider("openai", {
    label: "OpenAI (GPT)",
    type: "openai",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-5.3-codex",
    models: ["gpt-5.3-codex", "gpt-5.2", "gpt-4o-mini"],
    key_env: "OPENAI_API_KEY",
    supports_vision: true,
    auth_modes: ["api_key", "oauth", "token"],
    supports_oauth: true
  }),
  "openai-codex": defineProvider("openai-codex", {
    label: "OpenAI Codex",
    type: "openai-compatible",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-5.3-codex",
    models: ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2"],
    key_env: "OPENAI_API_KEY",
    supports_vision: true,
    auth_modes: ["oauth", "token"],
    supports_oauth: true,
    auth_docs_url: "https://platform.openai.com/",
    oauth_authorize_url: "https://auth.openai.com/oauth/authorize",
    oauth_token_url: "https://auth.openai.com/oauth/token",
    oauth_scopes: ["openid", "profile", "email", "offline_access"]
  }),
  qwen: defineProvider("qwen", {
    label: "Qwen (DashScope)",
    type: "openai-compatible",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen-max",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-coder-plus"],
    key_env: "DASHSCOPE_API_KEY",
    supports_vision: true
  }),
  "qwen-portal": defineProvider("qwen-portal", {
    label: "Qwen Portal OAuth",
    type: "openai-compatible",
    base_url: "https://chat.qwen.ai/api/openai/v1",
    default_model: "qwen3-coder-plus",
    models: ["qwen3-coder-plus", "qwen-max", "qwen-plus"],
    supports_vision: true,
    auth_modes: ["oauth", "token"],
    supports_oauth: true,
    oauth_flow: "device_code",
    oauth_token_url: "https://chat.qwen.ai/api/v1/oauth2/token",
    oauth_client_id: "f0304373b74a44d2b584a3fb70ca9e56"
  }),
  gemini: defineProvider("gemini", {
    label: "Google Gemini",
    type: "openai-compatible",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    default_model: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    key_env: "GEMINI_API_KEY",
    supports_vision: true,
    auth_modes: ["api_key", "oauth", "token"],
    supports_oauth: true
  }),
  "github-copilot": defineProvider("github-copilot", {
    label: "GitHub Copilot",
    type: "openai-compatible",
    base_url: "https://api.individual.githubcopilot.com",
    default_model: "gpt-4o",
    models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4.6"],
    key_env: "GITHUB_TOKEN",
    supports_vision: true,
    auth_modes: ["oauth", "token"],
    supports_oauth: true
  }),
  "coding-plan": defineProvider("coding-plan", {
    label: "Coding Plan (DashScope Coding)",
    type: "openai-compatible",
    base_url: "https://coding.dashscope.aliyuncs.com/v1",
    default_model: "qwen3.5-plus",
    models: ["qwen3.5-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3-coder-next", "qwen3-coder-plus", "glm-4.7"],
    key_env: "CODING_PLAN_API_KEY",
    context_limit: 983616,
    supports_vision: true,
    include_in_defaults: false,
    protocols: {
      openai: {
        type: "openai-compatible",
        base_url: "https://coding.dashscope.aliyuncs.com/v1"
      },
      anthropic: {
        type: "anthropic",
        base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic"
      }
    }
  }),
  glm: defineProvider("glm", {
    label: "Zhipu GLM",
    type: "openai-compatible",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-4-plus",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    key_env: "ZHIPU_API_KEY",
    supports_vision: true
  }),
  deepseek: defineProvider("deepseek", {
    label: "DeepSeek",
    type: "openai-compatible",
    base_url: "https://api.deepseek.com/v1",
    default_model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    key_env: "DEEPSEEK_API_KEY",
    supports_thinking: true
  }),
  openrouter: defineProvider("openrouter", {
    label: "OpenRouter",
    type: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "openai/gpt-4.1-mini",
    models: ["openai/gpt-4.1-mini", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    key_env: "OPENROUTER_API_KEY",
    headers: {
      "HTTP-Referer": "https://kkcode.chat",
      "X-Title": "kkcode CLI"
    },
    supports_vision: true
  }),
  groq: defineProvider("groq", {
    label: "Groq",
    type: "openai-compatible",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "deepseek-r1-distill-llama-70b"],
    key_env: "GROQ_API_KEY"
  }),
  together: defineProvider("together", {
    label: "Together",
    type: "openai-compatible",
    base_url: "https://api.together.xyz/v1",
    default_model: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    models: ["meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", "Qwen/Qwen2.5-Coder-32B-Instruct", "deepseek-ai/DeepSeek-V3"],
    key_env: "TOGETHER_API_KEY"
  }),
  mistral: defineProvider("mistral", {
    label: "Mistral",
    type: "openai-compatible",
    base_url: "https://api.mistral.ai/v1",
    default_model: "mistral-large-latest",
    models: ["mistral-large-latest", "codestral-latest", "ministral-8b-latest"],
    key_env: "MISTRAL_API_KEY"
  }),
  huggingface: defineProvider("huggingface", {
    label: "Hugging Face",
    type: "openai-compatible",
    base_url: "https://router.huggingface.co/v1",
    default_model: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "Qwen/Qwen2.5-Coder-32B-Instruct", "meta-llama/Llama-3.3-70B-Instruct"],
    key_env: "HUGGINGFACE_API_KEY"
  }),
  zai: defineProvider("zai", {
    label: "Z.AI / GLM",
    type: "openai-compatible",
    base_url: "https://api.z.ai/api/paas/v4",
    default_model: "glm-5",
    models: ["glm-5", "glm-4.7"],
    key_env: "ZAI_API_KEY"
  }),
  minimax: defineProvider("minimax", {
    label: "MiniMax",
    type: "anthropic",
    base_url: "https://api.minimax.io/anthropic",
    default_model: "MiniMax-M2.5",
    models: ["MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.7"],
    key_env: "MINIMAX_API_KEY"
  }),
  "minimax-portal": defineProvider("minimax-portal", {
    label: "MiniMax Portal",
    type: "anthropic",
    base_url: "https://api.minimax.io/anthropic",
    default_model: "MiniMax-M2.7",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"],
    auth_modes: ["oauth", "token"],
    supports_oauth: true,
    oauth_flow: "device_code",
    auth_docs_url: "https://platform.minimax.io/",
    oauth_token_url: "https://api.minimax.io/oauth/token",
    oauth_client_id: "78257093-7e40-4613-99e0-527b14b39113"
  }),
  xai: defineProvider("xai", {
    label: "xAI (Grok)",
    type: "openai-compatible",
    base_url: "https://api.x.ai/v1",
    default_model: "grok-4",
    models: ["grok-4", "grok-code-fast-1", "grok-2-latest", "grok-beta"],
    key_env: "XAI_API_KEY"
  }),
  moonshot: defineProvider("moonshot", {
    label: "Moonshot",
    type: "openai-compatible",
    base_url: "https://api.moonshot.cn/v1",
    default_model: "moonshot-v1-32k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    key_env: "MOONSHOT_API_KEY"
  }),
  xiaomi: defineProvider("xiaomi", {
    label: "Xiaomi MiMo",
    type: "anthropic",
    base_url: "https://api.xiaomimimo.com/anthropic",
    default_model: "mimo-v2-flash",
    models: ["mimo-v2-flash"],
    key_env: "XIAOMI_API_KEY"
  }),
  venice: defineProvider("venice", {
    label: "Venice",
    type: "openai-compatible",
    base_url: "https://api.venice.ai/api/v1",
    default_model: "llama-3.3-70b",
    models: ["llama-3.3-70b", "qwen-2.5-coder-32b", "deepseek-r1-671b"],
    key_env: "VENICE_API_KEY"
  }),
  ollama: defineProvider("ollama", {
    label: "Ollama (local)",
    type: "ollama",
    base_url: "http://localhost:11434",
    default_model: "llama3.1",
    models: ["qwen3", "deepseek-coder", "llama3.1"],
    auth_modes: ["none"]
  }),
  "openai-compatible": defineProvider("openai-compatible", {
    label: "Generic OpenAI-Compatible",
    type: "openai-compatible",
    base_url: "",
    default_model: "",
    models: [],
    key_env: "",
    include_in_defaults: false
  })
}

export function listCatalogProviders({
  includeInDefaults = null,
  includeInInit = null,
  includeInWizard = null
} = {}) {
  return Object.values(PROVIDER_CATALOG).filter((spec) => {
    if (includeInDefaults !== null && spec.include_in_defaults !== includeInDefaults) return false
    if (includeInInit !== null && spec.include_in_init !== includeInInit) return false
    if (includeInWizard !== null && spec.include_in_wizard !== includeInWizard) return false
    return true
  })
}

export function getProviderSpec(providerId) {
  return PROVIDER_CATALOG[providerId] || null
}

export function buildProviderEntryFromCatalog(providerId, overrides = {}) {
  const spec = getProviderSpec(providerId)
  if (!spec) return null
  const entry = {
    base_url: overrides.base_url ?? spec.base_url,
    api_key_env: overrides.api_key_env ?? spec.key_env,
    default_model: overrides.default_model ?? spec.default_model,
    models: overrides.models ?? [...spec.models]
  }
  const providerType = overrides.type ?? spec.type
  if (providerType && providerType !== providerId) {
    entry.type = providerType
  }
  if (spec.headers || overrides.headers) {
    entry.headers = {
      ...(spec.headers || {}),
      ...(overrides.headers || {})
    }
  }
  if (spec.context_limit || overrides.context_limit) {
    entry.context_limit = overrides.context_limit ?? spec.context_limit
  }
  return entry
}

export function buildWizardPreset(providerId) {
  const spec = getProviderSpec(providerId)
  if (!spec) return null
  return {
    label: spec.label,
    type: spec.type,
    base_url: spec.base_url,
    default_model: spec.default_model,
    models: [...spec.models],
    supports_thinking: spec.supports_thinking,
    supports_vision: spec.supports_vision,
    key_env: spec.key_env,
    headers: spec.headers ? { ...spec.headers } : undefined,
    context_limit: spec.context_limit,
    protocols: spec.protocols ? structuredClone(spec.protocols) : undefined,
    auth_modes: [...spec.auth_modes],
    supports_oauth: spec.supports_oauth
  }
}

export const WIZARD_PROVIDER_PRESETS = Object.fromEntries(
  listCatalogProviders({ includeInWizard: true }).map((spec) => [spec.id, buildWizardPreset(spec.id)])
)
