import { DEFAULT_SENSITIVE_FILE_PATTERNS } from "../permission/file-edit-policy.mjs"

export const DEFAULT_CONFIG = {
  config_version: 1,
  language: "en",
  provider: {
    default: "openai",
    strict_mode: false,
    openai: {
      base_url: "https://api.openai.com/v1",
      api_key_env: "OPENAI_API_KEY",
      default_model: "gpt-5.5",
      models: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      timeout_ms: 120000,
      stream_idle_timeout_ms: 120000,
      max_tokens: 32768,
      context_limit: null,
      retry_attempts: 5,
      retry_base_delay_ms: 800,
      stream: true,
      thinking: null
    },
    anthropic: {
      base_url: "https://api.anthropic.com/v1",
      api_key_env: "ANTHROPIC_API_KEY",
      default_model: "claude-sonnet-4-6",
      models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      timeout_ms: 120000,
      stream_idle_timeout_ms: 120000,
      max_tokens: 32768,
      context_limit: null,
      retry_attempts: 5,
      retry_base_delay_ms: 800,
      stream: true,
      thinking: null
    },
    "kimi-code": {
      type: "openai-compatible",
      base_url: "https://api.kimi.com/coding/v1",
      api_key_env: "KIMI_CODE_API_KEY",
      default_model: "k3",
      models: ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
      timeout_ms: 180000,
      stream_idle_timeout_ms: 180000,
      max_tokens: 32768,
      context_limit: 1048576,
      retry_attempts: 5,
      retry_base_delay_ms: 800,
      stream: true,
      reasoning_effort: "high",
      thinking: null
    },
    ollama: {
      base_url: "http://localhost:11434",
      api_key_env: "",
      default_model: "llama3.1",
      timeout_ms: 300000,
      stream_idle_timeout_ms: 300000,
      max_tokens: 32768,
      context_limit: null,
      retry_attempts: 5,
      retry_base_delay_ms: 1000,
      stream: true,
      thinking: null
    },
    model_context: {
      k3: 1048576,
      "kimi-for-coding": 262144,
      "kimi-for-coding-highspeed": 262144
    }
  },
  agent: {
    default_mode: "assistant",
    max_steps: 8,
    longagent: {
      max_iterations: 0,
      no_progress_warning: 3,
      no_progress_limit: 5,
      max_stage_recoveries: 3,
      heartbeat_timeout_ms: 120000,
      checkpoint_interval: 5,
      lock_timeout_ms: 5000,
      parallel: {
        enabled: true,
        max_concurrency: 3,
        stage_pass_rule: "all_success",
        task_timeout_ms: 600000,
        task_max_retries: 2,
        poll_interval_ms: 300
      },
      planner: {
        intake_questions: {
          enabled: true,
          max_rounds: 6
        },
        ask_user_after_plan_frozen: false
      },
      hybrid: {
        intake: true,
        completion_validation: true,
        debugging_max_iterations: 20,
        max_coding_rollbacks: 2,
        parallel_preview: true,
        blueprint_review: false,
        blueprint_validation: true,
        tdd_mode: false,
        cross_review: true,
        incremental_gates: true,
        context_pressure_limit: 8000,
        budget_awareness: true,
        checkpoint_resume: true,
        project_memory: true,
        task_bus: true,
        coding_phase_timeout_ms: 1800000,
        debugging_phase_timeout_ms: 600000,
        checkpoint_max_keep: 10,
        checkpoint_cleanup: true,
        degradation: {
          enabled: true,
          fallback_model: null,
          skip_non_critical: true
        },
        separate_models: {
          enabled: false,
          preview_model: null,
          blueprint_model: null,
          debugging_model: null
        },
        adaptive_models: {
          enabled: false,
          low: null,
          medium: null,
          high: null
        }
      },
      resume_incomplete_files: true,
      scaffold: {
        enabled: true
      },
      git: {
        enabled: "ask",
        auto_branch: true,
        auto_commit_stages: true,
        auto_merge: true,
        branch_prefix: "kkcode"
      },
      usability_gates: {
        prompt_user: "first_run",
        build: { enabled: true },
        test: { enabled: true },
        review: { enabled: true },
        health: { enabled: true },
        budget: { enabled: true }
      }
    },
    subagents: {},
    routing: {
      categories: {}
    }
  },
  mcp: {
    servers: {},
    auto_discover: true,
    timeout_ms: 30000,
    max_reconnect_attempts: 5,
    circuit_reset_ms: 60000,
    health_check_interval_ms: 0,
    max_buffer_bytes: 16777216,
    shutdown_timeout_ms: 5000,
    max_sse_buffer_bytes: 4194304
  },
  skills: {
    enabled: true,
    auto_seed: true,
    dirs: [".kkcode/skills"],
    allowed_commands: []
  },
  compat: {
    skills: {
      paths: []
    },
    plugins: {
      enabled: true,
      ecosystems: ["kkcode", "claude", "codex", "opencode"],
      execute_external_hooks: false
    },
    opencode_plugins: {
      enabled: false
    },
    diagnostics: {
      strict: false
    }
  },
  permission: {
    level: "manual",
    non_tty_default: "deny",
    rules: []
  },
  storage: {
    session_shard_enabled: true,
    flush_interval_ms: 1000,
    event_rotate_mb: 32,
    event_retain_days: 14
  },
  background: {
    mode: "worker_process",
    worker_timeout_ms: 900000,
    max_parallel: 2,
    max_log_lines: 300
  },
  runtime: {
    tool_registry_cache_ttl_ms: 30000,
    mcp_refresh_ttl_ms: 60000
  },
  tool: {
    sources: {
      builtin: true,
      local: true,
      mcp: true,
      plugin: true
    },
    bash_timeout_ms: 120000,
    write_lock: {
      mode: "file_lock",
      wait_timeout_ms: 120000
    },
    sensitive_file_patterns: [...DEFAULT_SENSITIVE_FILE_PATTERNS],
    local_dirs: [".kkcode/tools", ".kkcode/tool"],
    plugin_dirs: [".kkcode/plugins", ".kkcode/plugin"]
  },
  session: {
    max_history: 30,
    recovery: true,
    compaction_threshold_ratio: 0.7,
    compaction_threshold_messages: 50,
    context_cache_points: true
  },
  review: {
    sort: "risk_first",
    default_lines: 80,
    max_expand_lines: 1200,
    risk_weights: {
      sensitive_path: 4,
      large_change: 3,
      medium_change: 2,
      small_change: 1,
      executable_script: 2,
      command_pattern: 3
    }
  },
  usage: {
    pricing_file: null,
    aggregation: ["turn", "session", "global"],
    budget: {
      session_usd: null,
      global_usd: null,
      warn_at_percent: 80,
      strategy: "warn"
    }
  },
  update: {
    enabled: true,
    notify_on_startup: true,
    auto_install: false,
    channel: "latest",
    check_interval_hours: 12,
    registry: "https://registry.npmjs.org",
    timeout_ms: 2500
  },
  ui: {
    theme_file: null,
    mode_colors: {
      assistant: "#22d3ee",
      plan: "#00b7c2",
      agent: "#2ac26f",
      longagent: "#ff7a33"
    },
    layout: "compact",
    markdown_render: true,
    terminal: {
      alternate_screen: "auto",
      mouse: "auto",
      bracketed_paste: true,
      copy_on_select: true,
      toast_duration_ms: 2600
    },
    status: {
      show_cost: true,
      show_token_meter: true
    }
  }
}

export const VALID_PROVIDER_TYPES = ["openai", "anthropic", "ollama", "openai-compatible", "gateway"]

import { listProviders } from "../provider/router.mjs"
export function getValidProviderTypes() {
  return listProviders()
}
export const VALID_MODES = ["assistant", "plan", "agent", "code", "coding", "longagent"]
export const VALID_REVIEW_SORT = ["risk_first", "time_order", "file_order"]
export const VALID_LANGUAGES = ["en", "zh"]
