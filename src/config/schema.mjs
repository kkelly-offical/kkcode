import { VALID_MODES, VALID_PROVIDER_TYPES, VALID_REVIEW_SORT, getValidProviderTypes } from "./defaults.mjs"

const HEX = /^#([A-Fa-f0-9]{6})$/

function err(list, field, message) {
  list.push(`${field}: ${message}`)
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function checkInt(errors, field, value, min = 0) {
  if (!Number.isInteger(value) || value < min) err(errors, field, `must be integer >= ${min}`)
}

function checkColor(errors, field, value) {
  if (typeof value !== "string" || !HEX.test(value)) err(errors, field, "must be hex color like #112233")
}

function checkGateEnabledObject(errors, field, value) {
  if (!isObj(value)) {
    err(errors, field, "must be object")
    return
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    err(errors, `${field}.enabled`, "must be boolean")
  }
}

export function validateConfig(config) {
  const errors = []
  if (!isObj(config)) {
    return { valid: false, errors: ["config must be object"] }
  }

  if (config.provider !== undefined) {
    if (!isObj(config.provider)) {
      err(errors, "provider", "must be object")
    } else {
      const providerTypes = getValidProviderTypes()
      const knownKeys = new Set([...providerTypes, ...Object.keys(config.provider).filter(k => k !== "default")])
      if (config.provider.default !== undefined && !knownKeys.has(config.provider.default)) {
        err(errors, "provider.default", `must be one of ${[...knownKeys].join(", ")}`)
      }
      const providerKeys = new Set([...providerTypes, ...Object.keys(config.provider).filter(k => k !== "default")])
      for (const key of providerKeys) {
        const p = config.provider[key]
        if (p === undefined) continue
        if (!isObj(p)) {
          err(errors, `provider.${key}`, "must be object")
          continue
        }
        if (p.type !== undefined && typeof p.type !== "string") err(errors, `provider.${key}.type`, "must be string")
        if (p.base_url !== undefined && typeof p.base_url !== "string") err(errors, `provider.${key}.base_url`, "must be string")
        if (p.api_key_env !== undefined && typeof p.api_key_env !== "string") err(errors, `provider.${key}.api_key_env`, "must be string")
        if (p.default_model !== undefined && typeof p.default_model !== "string") err(errors, `provider.${key}.default_model`, "must be string")
        if (p.timeout_ms !== undefined) checkInt(errors, `provider.${key}.timeout_ms`, p.timeout_ms, 1000)
        if (p.retry_attempts !== undefined) checkInt(errors, `provider.${key}.retry_attempts`, p.retry_attempts, 0)
        if (p.retry_base_delay_ms !== undefined) checkInt(errors, `provider.${key}.retry_base_delay_ms`, p.retry_base_delay_ms, 100)
        if (p.stream !== undefined && typeof p.stream !== "boolean") err(errors, `provider.${key}.stream`, "must be boolean")
      }
    }
  }

  if (config.agent !== undefined) {
    if (!isObj(config.agent)) err(errors, "agent", "must be object")
    else {
      if (config.agent.default_mode !== undefined && !VALID_MODES.includes(config.agent.default_mode)) {
        err(errors, "agent.default_mode", `must be one of ${VALID_MODES.join(", ")}`)
      }
      if (config.agent.max_steps !== undefined) checkInt(errors, "agent.max_steps", config.agent.max_steps, 1)
      if (config.agent.longagent !== undefined) {
        if (!isObj(config.agent.longagent)) err(errors, "agent.longagent", "must be object")
        else {
          if (config.agent.longagent.max_iterations !== undefined) {
            checkInt(errors, "agent.longagent.max_iterations", config.agent.longagent.max_iterations, 0)
          }
          if (config.agent.longagent.no_progress_warning !== undefined) {
            checkInt(errors, "agent.longagent.no_progress_warning", config.agent.longagent.no_progress_warning, 1)
          }
          if (config.agent.longagent.no_progress_limit !== undefined) {
            checkInt(errors, "agent.longagent.no_progress_limit", config.agent.longagent.no_progress_limit, 1)
          }
          if (config.agent.longagent.heartbeat_timeout_ms !== undefined) {
            checkInt(errors, "agent.longagent.heartbeat_timeout_ms", config.agent.longagent.heartbeat_timeout_ms, 1000)
          }
          if (config.agent.longagent.checkpoint_interval !== undefined) {
            checkInt(errors, "agent.longagent.checkpoint_interval", config.agent.longagent.checkpoint_interval, 0)
          }
          if (config.agent.longagent.parallel !== undefined) {
            if (!isObj(config.agent.longagent.parallel)) {
              err(errors, "agent.longagent.parallel", "must be object")
            } else {
              if (config.agent.longagent.parallel.enabled !== undefined && typeof config.agent.longagent.parallel.enabled !== "boolean") {
                err(errors, "agent.longagent.parallel.enabled", "must be boolean")
              }
              if (config.agent.longagent.parallel.max_concurrency !== undefined) {
                checkInt(errors, "agent.longagent.parallel.max_concurrency", config.agent.longagent.parallel.max_concurrency, 1)
              }
              if (config.agent.longagent.parallel.stage_pass_rule !== undefined && config.agent.longagent.parallel.stage_pass_rule !== "all_success") {
                err(errors, "agent.longagent.parallel.stage_pass_rule", "must be all_success")
              }
              if (config.agent.longagent.parallel.task_timeout_ms !== undefined) {
                checkInt(errors, "agent.longagent.parallel.task_timeout_ms", config.agent.longagent.parallel.task_timeout_ms, 1000)
              }
              if (config.agent.longagent.parallel.task_max_retries !== undefined) {
                checkInt(errors, "agent.longagent.parallel.task_max_retries", config.agent.longagent.parallel.task_max_retries, 0)
              }
            }
          }
          if (config.agent.longagent.planner !== undefined) {
            if (!isObj(config.agent.longagent.planner)) {
              err(errors, "agent.longagent.planner", "must be object")
            } else {
              if (config.agent.longagent.planner.intake_questions !== undefined) {
                if (!isObj(config.agent.longagent.planner.intake_questions)) {
                  err(errors, "agent.longagent.planner.intake_questions", "must be object")
                } else {
                  if (config.agent.longagent.planner.intake_questions.enabled !== undefined && typeof config.agent.longagent.planner.intake_questions.enabled !== "boolean") {
                    err(errors, "agent.longagent.planner.intake_questions.enabled", "must be boolean")
                  }
                  if (config.agent.longagent.planner.intake_questions.max_rounds !== undefined) {
                    checkInt(errors, "agent.longagent.planner.intake_questions.max_rounds", config.agent.longagent.planner.intake_questions.max_rounds, 1)
                  }
                }
              }
              if (config.agent.longagent.planner.ask_user_after_plan_frozen !== undefined && typeof config.agent.longagent.planner.ask_user_after_plan_frozen !== "boolean") {
                err(errors, "agent.longagent.planner.ask_user_after_plan_frozen", "must be boolean")
              }
            }
          }
          if (config.agent.longagent.resume_incomplete_files !== undefined && typeof config.agent.longagent.resume_incomplete_files !== "boolean") {
            err(errors, "agent.longagent.resume_incomplete_files", "must be boolean")
          }
          if (config.agent.longagent.usability_gates !== undefined) {
            if (!isObj(config.agent.longagent.usability_gates)) {
              err(errors, "agent.longagent.usability_gates", "must be object")
            } else {
              checkGateEnabledObject(errors, "agent.longagent.usability_gates.build", config.agent.longagent.usability_gates.build || {})
              checkGateEnabledObject(errors, "agent.longagent.usability_gates.test", config.agent.longagent.usability_gates.test || {})
              checkGateEnabledObject(errors, "agent.longagent.usability_gates.review", config.agent.longagent.usability_gates.review || {})
              checkGateEnabledObject(errors, "agent.longagent.usability_gates.health", config.agent.longagent.usability_gates.health || {})
              checkGateEnabledObject(errors, "agent.longagent.usability_gates.budget", config.agent.longagent.usability_gates.budget || {})
            }
          }
        }
      }
      if (config.agent.subagents !== undefined && !isObj(config.agent.subagents)) {
        err(errors, "agent.subagents", "must be object")
      }
      if (config.agent.routing !== undefined && !isObj(config.agent.routing)) {
        err(errors, "agent.routing", "must be object")
      }
    }
  }

  if (config.mcp !== undefined) {
    if (!isObj(config.mcp)) err(errors, "mcp", "must be object")
    else {
      if (config.mcp.servers !== undefined && !isObj(config.mcp.servers)) err(errors, "mcp.servers", "must be object")
      if (config.mcp.timeout_ms !== undefined) checkInt(errors, "mcp.timeout_ms", config.mcp.timeout_ms, 1000)
      if (config.mcp.auto_discover !== undefined && typeof config.mcp.auto_discover !== "boolean") {
        err(errors, "mcp.auto_discover", "must be boolean")
      }
      if (isObj(config.mcp.servers)) {
        for (const [name, server] of Object.entries(config.mcp.servers)) {
          const prefix = `mcp.servers.${name}`
          if (!isObj(server)) {
            err(errors, prefix, "must be object")
            continue
          }
          if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
            err(errors, `${prefix}.enabled`, "must be boolean")
          }
          if (server.type !== undefined && typeof server.type !== "string") {
            err(errors, `${prefix}.type`, "must be string")
          }
          if (server.transport !== undefined && !["stdio", "http", "sse", "streamable-http"].includes(server.transport)) {
            err(errors, `${prefix}.transport`, "must be stdio|http|sse|streamable-http")
          }
          if (server.url !== undefined && typeof server.url !== "string") {
            err(errors, `${prefix}.url`, "must be string")
          }
          if (server.command !== undefined && !Array.isArray(server.command) && typeof server.command !== "string") {
            err(errors, `${prefix}.command`, "must be string or array")
          }
          if (server.args !== undefined) {
            if (!Array.isArray(server.args)) err(errors, `${prefix}.args`, "must be array")
            else if (server.args.some((item) => typeof item !== "string")) err(errors, `${prefix}.args`, "all values must be string")
          }
          if (server.env !== undefined && !isObj(server.env)) {
            err(errors, `${prefix}.env`, "must be object")
          } else if (isObj(server.env)) {
            for (const [k, v] of Object.entries(server.env)) {
              if (typeof v !== "string") err(errors, `${prefix}.env.${k}`, "must be string")
            }
          }
          if (server.headers !== undefined && !isObj(server.headers)) {
            err(errors, `${prefix}.headers`, "must be object")
          } else if (isObj(server.headers)) {
            for (const [k, v] of Object.entries(server.headers)) {
              if (typeof v !== "string") err(errors, `${prefix}.headers.${k}`, "must be string")
            }
          }
          if (server.shell !== undefined && typeof server.shell !== "boolean") {
            err(errors, `${prefix}.shell`, "must be boolean")
          }
          if (server.framing !== undefined && !["auto", "content-length", "newline"].includes(server.framing)) {
            err(errors, `${prefix}.framing`, "must be auto|content-length|newline")
          }
          if (server.health_check_method !== undefined && !["auto", "ping", "tools_list"].includes(server.health_check_method)) {
            err(errors, `${prefix}.health_check_method`, "must be auto|ping|tools_list")
          }
          if (server.startup_timeout_ms !== undefined) checkInt(errors, `${prefix}.startup_timeout_ms`, server.startup_timeout_ms, 100)
          if (server.request_timeout_ms !== undefined) checkInt(errors, `${prefix}.request_timeout_ms`, server.request_timeout_ms, 100)
          if (server.timeout_ms !== undefined) checkInt(errors, `${prefix}.timeout_ms`, server.timeout_ms, 100)
        }
      }
    }
  }

  if (config.skills !== undefined) {
    if (!isObj(config.skills)) err(errors, "skills", "must be object")
    else {
      if (config.skills.enabled !== undefined && typeof config.skills.enabled !== "boolean") {
        err(errors, "skills.enabled", "must be boolean")
      }
      if (config.skills.dirs !== undefined && !Array.isArray(config.skills.dirs)) {
        err(errors, "skills.dirs", "must be array")
      }
    }
  }

  if (config.permission !== undefined) {
    if (!isObj(config.permission)) err(errors, "permission", "must be object")
    else {
      if (config.permission.default_policy !== undefined && !["allow", "deny", "ask"].includes(config.permission.default_policy)) {
        err(errors, "permission.default_policy", "must be allow|deny|ask")
      }
      if (config.permission.non_tty_default !== undefined && !["allow_once", "deny"].includes(config.permission.non_tty_default)) {
        err(errors, "permission.non_tty_default", "must be allow_once|deny")
      }
      if (config.permission.rules !== undefined) {
        if (!Array.isArray(config.permission.rules)) err(errors, "permission.rules", "must be array")
        else {
          for (const [index, rule] of config.permission.rules.entries()) {
            if (!isObj(rule)) {
              err(errors, `permission.rules[${index}]`, "must be object")
              continue
            }
            if (typeof rule.tool !== "string") err(errors, `permission.rules[${index}].tool`, "must be string")
            if (!["allow", "deny", "ask"].includes(rule.action)) {
              err(errors, `permission.rules[${index}].action`, "must be allow|deny|ask")
            }
            if (rule.modes !== undefined) {
              if (!Array.isArray(rule.modes)) err(errors, `permission.rules[${index}].modes`, "must be array")
              else {
                for (const mode of rule.modes) {
                  if (!VALID_MODES.includes(mode)) err(errors, `permission.rules[${index}].modes`, `invalid mode ${mode}`)
                }
              }
            }
            if (rule.file_patterns !== undefined) {
              if (!Array.isArray(rule.file_patterns) && typeof rule.file_patterns !== "string") {
                err(errors, `permission.rules[${index}].file_patterns`, "must be string or array of strings")
              } else if (Array.isArray(rule.file_patterns)) {
                for (const pat of rule.file_patterns) {
                  if (typeof pat !== "string") err(errors, `permission.rules[${index}].file_patterns`, "each pattern must be string")
                }
              }
            }
            if (rule.command_prefix !== undefined) {
              if (!Array.isArray(rule.command_prefix) && typeof rule.command_prefix !== "string") {
                err(errors, `permission.rules[${index}].command_prefix`, "must be string or array of strings")
              } else if (Array.isArray(rule.command_prefix)) {
                for (const pfx of rule.command_prefix) {
                  if (typeof pfx !== "string") err(errors, `permission.rules[${index}].command_prefix`, "each prefix must be string")
                }
              }
            }
          }
        }
      }
    }
  }

  if (config.storage !== undefined) {
    if (!isObj(config.storage)) err(errors, "storage", "must be object")
    else {
      if (config.storage.session_shard_enabled !== undefined && typeof config.storage.session_shard_enabled !== "boolean") {
        err(errors, "storage.session_shard_enabled", "must be boolean")
      }
      if (config.storage.flush_interval_ms !== undefined) checkInt(errors, "storage.flush_interval_ms", config.storage.flush_interval_ms, 0)
      if (config.storage.event_rotate_mb !== undefined) checkInt(errors, "storage.event_rotate_mb", config.storage.event_rotate_mb, 1)
      if (config.storage.event_retain_days !== undefined) checkInt(errors, "storage.event_retain_days", config.storage.event_retain_days, 1)
    }
  }

  if (config.background !== undefined) {
    if (!isObj(config.background)) err(errors, "background", "must be object")
    else {
      if (config.background.mode !== undefined && !["worker_process"].includes(config.background.mode)) {
        err(errors, "background.mode", "must be worker_process")
      }
      if (config.background.worker_timeout_ms !== undefined) checkInt(errors, "background.worker_timeout_ms", config.background.worker_timeout_ms, 1000)
      if (config.background.max_parallel !== undefined) checkInt(errors, "background.max_parallel", config.background.max_parallel, 1)
    }
  }

  if (config.runtime !== undefined) {
    if (!isObj(config.runtime)) err(errors, "runtime", "must be object")
    else {
      if (config.runtime.tool_registry_cache_ttl_ms !== undefined) {
        checkInt(errors, "runtime.tool_registry_cache_ttl_ms", config.runtime.tool_registry_cache_ttl_ms, 0)
      }
      if (config.runtime.mcp_refresh_ttl_ms !== undefined) {
        checkInt(errors, "runtime.mcp_refresh_ttl_ms", config.runtime.mcp_refresh_ttl_ms, 0)
      }
    }
  }

  if (config.tool !== undefined) {
    if (!isObj(config.tool)) err(errors, "tool", "must be object")
    else {
      if (config.tool.sources !== undefined && !isObj(config.tool.sources)) err(errors, "tool.sources", "must be object")
      if (config.tool.write_lock !== undefined) {
        if (!isObj(config.tool.write_lock)) err(errors, "tool.write_lock", "must be object")
        else {
          if (config.tool.write_lock.mode !== undefined && !["file_lock", "none"].includes(config.tool.write_lock.mode)) {
            err(errors, "tool.write_lock.mode", "must be file_lock|none")
          }
          if (config.tool.write_lock.wait_timeout_ms !== undefined) {
            checkInt(errors, "tool.write_lock.wait_timeout_ms", config.tool.write_lock.wait_timeout_ms, 0)
          }
        }
      }
      if (config.tool.local_dirs !== undefined && !Array.isArray(config.tool.local_dirs)) err(errors, "tool.local_dirs", "must be array")
      if (config.tool.plugin_dirs !== undefined && !Array.isArray(config.tool.plugin_dirs)) err(errors, "tool.plugin_dirs", "must be array")
    }
  }

  if (config.session !== undefined) {
    if (!isObj(config.session)) err(errors, "session", "must be object")
    else {
      if (config.session.max_history !== undefined) checkInt(errors, "session.max_history", config.session.max_history, 1)
      if (config.session.recovery !== undefined && typeof config.session.recovery !== "boolean") {
        err(errors, "session.recovery", "must be boolean")
      }
      if (config.session.compaction_threshold_ratio !== undefined) {
        const ratio = Number(config.session.compaction_threshold_ratio)
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
          err(errors, "session.compaction_threshold_ratio", "must be number in (0,1]")
        }
      }
      if (config.session.compaction_threshold_messages !== undefined) {
        checkInt(errors, "session.compaction_threshold_messages", config.session.compaction_threshold_messages, 1)
      }
      if (config.session.context_cache_points !== undefined && typeof config.session.context_cache_points !== "boolean") {
        err(errors, "session.context_cache_points", "must be boolean")
      }
    }
  }

  if (config.review !== undefined) {
    if (!isObj(config.review)) err(errors, "review", "must be object")
    else {
      if (config.review.sort !== undefined && !VALID_REVIEW_SORT.includes(config.review.sort)) {
        err(errors, "review.sort", `must be one of ${VALID_REVIEW_SORT.join(", ")}`)
      }
      if (config.review.default_lines !== undefined) checkInt(errors, "review.default_lines", config.review.default_lines, 1)
      if (config.review.max_expand_lines !== undefined) checkInt(errors, "review.max_expand_lines", config.review.max_expand_lines, 1)
      if (config.review.risk_weights !== undefined) {
        if (!isObj(config.review.risk_weights)) err(errors, "review.risk_weights", "must be object")
        else {
          for (const [key, val] of Object.entries(config.review.risk_weights)) {
            if (typeof val !== "number" || val < 0) err(errors, `review.risk_weights.${key}`, "must be non-negative number")
          }
        }
      }
    }
  }

  if (config.usage !== undefined) {
    if (!isObj(config.usage)) err(errors, "usage", "must be object")
    else {
      if (config.usage.pricing_file !== undefined && config.usage.pricing_file !== null && typeof config.usage.pricing_file !== "string") {
        err(errors, "usage.pricing_file", "must be string|null")
      }
      if (config.usage.aggregation !== undefined) {
        if (!Array.isArray(config.usage.aggregation)) err(errors, "usage.aggregation", "must be array")
        else {
          for (const scope of config.usage.aggregation) {
            if (!["turn", "session", "global"].includes(scope)) err(errors, "usage.aggregation", `invalid scope ${scope}`)
          }
        }
      }
      if (config.usage.budget !== undefined) {
        if (!isObj(config.usage.budget)) err(errors, "usage.budget", "must be object")
        else {
          if (config.usage.budget.warn_at_percent !== undefined) {
            const v = config.usage.budget.warn_at_percent
            if (typeof v !== "number" || v <= 0 || v > 100) err(errors, "usage.budget.warn_at_percent", "must be number in (0,100]")
          }
          if (config.usage.budget.strategy !== undefined && !["warn", "block"].includes(config.usage.budget.strategy)) {
            err(errors, "usage.budget.strategy", "must be warn|block")
          }
        }
      }
    }
  }

  if (config.ui !== undefined) {
    if (!isObj(config.ui)) err(errors, "ui", "must be object")
    else {
      if (config.ui.theme_file !== undefined && config.ui.theme_file !== null && typeof config.ui.theme_file !== "string") {
        err(errors, "ui.theme_file", "must be string|null")
      }
      if (config.ui.mode_colors !== undefined) {
        if (!isObj(config.ui.mode_colors)) err(errors, "ui.mode_colors", "must be object")
        else {
          for (const mode of VALID_MODES) {
            if (config.ui.mode_colors[mode] !== undefined) checkColor(errors, `ui.mode_colors.${mode}`, config.ui.mode_colors[mode])
          }
        }
      }
      if (config.ui.layout !== undefined && !["compact", "comfortable"].includes(config.ui.layout)) {
        err(errors, "ui.layout", "must be compact|comfortable")
      }
      if (config.ui.markdown_render !== undefined && typeof config.ui.markdown_render !== "boolean") {
        err(errors, "ui.markdown_render", "must be boolean")
      }
      if (config.ui.status !== undefined) {
        if (!isObj(config.ui.status)) err(errors, "ui.status", "must be object")
        else {
          if (config.ui.status.show_cost !== undefined && typeof config.ui.status.show_cost !== "boolean") {
            err(errors, "ui.status.show_cost", "must be boolean")
          }
          if (config.ui.status.show_token_meter !== undefined && typeof config.ui.status.show_token_meter !== "boolean") {
            err(errors, "ui.status.show_token_meter", "must be boolean")
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
