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
      // 总 LLM 轮次硬上限（0 = 不限）。0.5.0 起真正生效：超限以
      // budget_exhausted 结束。轮次层面的约束见 ultra.* 段。
      max_iterations: 0,
      // 0.5.0 goal 模式：不达目的不放弃，约束是「有没有进展」而非轮次
      ultra: {
        goal_mode: true,                    // false = 退回 0.4.x 单轮语义（逃生阀）
        max_rounds: 0,                      // 0 = 不限，由停滞/时限/预算兜底
        deadline_ms: 7200000,               // 2 小时；0 = 不限
        no_progress_rounds: 2,              // 连续 N 轮无强进展判受阻
        on_blocked_non_tty: "deliver_partial",  // deliver_partial | stop | continue
        stage_failure: {
          allow_skip: true,
          allow_defer: true,
          max_replans: 2
        },
        criteria: {
          allow_shell: false,
          command_timeout_ms: 120000,
          command_allowlist: ["node", "npm", "npx", "pnpm", "yarn", "python", "python3",
            "pytest", "go", "cargo", "make", "tsc", "eslint", "jest", "vitest", "mocha", "git"]
        },
        report: { llm_summary: true, write_markdown: true },
        ledger: { enabled: true, max_rounds_kept: 10 }
      },
      max_stage_recoveries: 3,
      // 同一 stage 的累计尝试硬上限；降级会清零 max_stage_recoveries，
      // 这个总账不清零，防止无限重跑
      max_stage_attempts: 12,
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
  // 模型角色。留空表示回退：main → provider.<default>.default_model，
  // subagent → main。fast 刻意不回退，未配置即关闭依赖它的可选功能。
  models: {
    main: null,
    fast: null,
    subagent: null,
    // Ultra 分阶段模型（0.4.0 推迟的能力）。缺省 null = 沿用 main；
    // report 缺省走 fast → main。旧的 hybrid.separate_models 仍然生效。
    ultra: {
      preview: null,
      blueprint: null,
      coding: null,
      debugging: null,
      report: null
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
    // 0.6.0：主判据是占用比例（85%），消息数从并列触发器降级为高位安全网
    // —— 0.5.x 的 50 条 OR 语义让长会话几乎总是消息数先撞线，比例形同虚设。
    compaction_threshold_ratio: 0.85,
    compaction_threshold_messages: 200,
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
    composer: {
      // auto = 配置了 models.fast 才启用下一句预测；off = 始终关闭
      ghost_text: "auto"
    },
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
