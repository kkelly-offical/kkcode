export const DEFAULT_CONFIG = {
  language: "en",
  provider: {
    default: "openai",
    openai: {
      base_url: "https://api.openai.com/v1",
      api_key_env: "OPENAI_API_KEY",
      default_model: "gpt-5.3-codex",
      models: ["gpt-5.3-codex", "gpt-5.2"],
      timeout_ms: 120000,
      stream_idle_timeout_ms: 120000,
      max_tokens: 32768,
      retry_attempts: 3,
      retry_base_delay_ms: 800,
      stream: true
    },
    anthropic: {
      base_url: "https://api.anthropic.com/v1",
      api_key_env: "ANTHROPIC_API_KEY",
      default_model: "claude-opus-4-6",
      models: ["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-6"],
      timeout_ms: 120000,
      stream_idle_timeout_ms: 120000,
      max_tokens: 32768,
      retry_attempts: 3,
      retry_base_delay_ms: 800,
      stream: true
    },
    ollama: {
      base_url: "http://localhost:11434",
      api_key_env: "",
      default_model: "llama3.1",
      timeout_ms: 300000,
      stream_idle_timeout_ms: 300000,
      max_tokens: 32768,
      retry_attempts: 1,
      retry_base_delay_ms: 1000,
      stream: true
    }
  },
  agent: {
    default_mode: "agent",
    max_steps: 8,
    longagent: {
      max_iterations: 0,
      no_progress_warning: 3,
      no_progress_limit: 5,
      max_stage_recoveries: 3,
      heartbeat_timeout_ms: 120000,
      checkpoint_interval: 5,
      parallel: {
        enabled: true,
        max_concurrency: 3,
        stage_pass_rule: "all_success",
        task_timeout_ms: 600000,
        task_max_retries: 2
      },
      planner: {
        intake_questions: {
          enabled: true,
          max_rounds: 6
        },
        ask_user_after_plan_frozen: false
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
    timeout_ms: 30000
  },
  skills: {
    enabled: true,
    dirs: [".kkcode/skills"]
  },
  permission: {
    default_policy: "ask",
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
    max_parallel: 2
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
    write_lock: {
      mode: "file_lock",
      wait_timeout_ms: 120000
    },
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
  ui: {
    theme_file: null,
    mode_colors: {
      ask: "#8da3b9",
      plan: "#00b7c2",
      agent: "#2ac26f",
      longagent: "#ff7a33"
    },
    layout: "compact",
    markdown_render: true,
    status: {
      show_cost: true,
      show_token_meter: true
    }
  }
}

export const VALID_PROVIDER_TYPES = ["openai", "anthropic", "ollama", "openai-compatible"]

import { listProviders } from "../provider/router.mjs"
export function getValidProviderTypes() {
  return listProviders()
}
export const VALID_MODES = ["ask", "plan", "agent", "longagent"]
export const VALID_REVIEW_SORT = ["risk_first", "time_order", "file_order"]
export const VALID_LANGUAGES = ["en", "zh"]
