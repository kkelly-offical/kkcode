import { normalizePermissionLevel } from "../permission/rules.mjs"
import { resolveRoleModel } from "../provider/model-roles.mjs"
import { fastModelIssues } from "../provider/fast-model.mjs"
import { PACKAGE_VERSION } from "../version.mjs"

/**
 * 启动自检。
 *
 * 与 `kkcode doctor` 的分工：doctor 是排障工具，会做 session fsck、审计链
 * 校验、后台任务统计这些重活；preflight 只回答「现在能不能正常干活」，
 * 因此只看配置、provider 凭据、MCP、skills 和版本，足够轻到每次启动都跑。
 *
 * 纯函数：调用方把已经加载好的注册表快照传进来，这里不做任何 IO。
 */

export const PREFLIGHT_OK = "ok"
export const PREFLIGHT_WARN = "warn"
export const PREFLIGHT_FAIL = "fail"

function providerCheck(configState) {
  const config = configState?.config || {}
  const name = config.provider?.default || ""
  const providerCfg = config.provider?.[name] || {}
  const model = resolveRoleModel(config, "main", { providerType: name })

  if (!name) {
    return { status: PREFLIGHT_FAIL, name: "", model: "", detail: "no default provider configured" }
  }
  if (!Object.keys(providerCfg).length) {
    return { status: PREFLIGHT_FAIL, name, model, detail: `provider "${name}" is not defined` }
  }

  // 凭据：显式 api_key 或 api_key_env 指向的环境变量二选一；本地端点可无凭据
  const envName = providerCfg.api_key_env || ""
  const hasKey = Boolean(providerCfg.api_key) || Boolean(envName && process.env[envName])
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(String(providerCfg.base_url || ""))

  if (!hasKey && !isLocal) {
    return {
      status: PREFLIGHT_FAIL,
      name,
      model,
      detail: envName ? `${envName} is not set` : "no api_key or api_key_env configured"
    }
  }
  if (!model) {
    return { status: PREFLIGHT_WARN, name, model: "", detail: "no default_model resolved" }
  }
  return { status: PREFLIGHT_OK, name, model, detail: hasKey ? "key set" : "authless local endpoint" }
}

/**
 * fast 通道：未配置是正常状态（对应功能关闭），被断路器停用才是问题 ——
 * 那意味着 ghost text 一直在发请求却什么都产不出来。
 */
function fastModelCheck(configState, issues) {
  const model = resolveRoleModel(configState?.config || {}, "fast")
  if (!model) {
    return { status: PREFLIGHT_OK, model: "", detail: "not configured (ghost text off)", issues: [] }
  }
  if (issues.length) {
    return {
      status: PREFLIGHT_WARN,
      model,
      detail: `${issues[0].model}: ${issues[0].reason}；已自动停用，可改用其他渠道的即答模型（models.fast: "provider/model"）`,
      issues
    }
  }
  return { status: PREFLIGHT_OK, model, detail: model, issues: [] }
}

function mcpCheck(mcp = {}) {
  const configured = Number(mcp.configured || 0)
  const healthy = Number(mcp.healthy || 0)
  const unhealthy = Number(mcp.unhealthy || 0)
  if (!configured) return { status: PREFLIGHT_OK, configured, healthy, unhealthy, detail: "none configured" }
  if (unhealthy) {
    return { status: PREFLIGHT_WARN, configured, healthy, unhealthy, detail: `${unhealthy} unhealthy` }
  }
  return { status: PREFLIGHT_OK, configured, healthy, unhealthy, detail: `${healthy}/${configured} healthy` }
}

function skillCheck(skills = {}) {
  const total = Number(skills.total || 0)
  return {
    status: PREFLIGHT_OK,
    total,
    detail: total ? `${total} loaded` : "none loaded"
  }
}

function configCheck(configState) {
  const source = configState?.source || {}
  const warnings = Array.isArray(configState?.warnings) ? configState.warnings : []
  const paths = [source.userPath, source.projectPath].filter(Boolean)

  // loadConfig 校验失败时整份文件被丢弃、只留 errors —— 而这里原先只读
  // warnings（loadConfig 从不产生这个字段），于是「配置全丢了」的会话
  // preflight 照样报 ok、退出码 0。这正是自检最该拦住的一种状态。
  const errors = Array.isArray(configState?.errors) ? configState.errors : []
  if (errors.length) {
    return {
      status: PREFLIGHT_FAIL,
      paths,
      detail: `${errors[0]}（该文件已被整份忽略，正在使用默认配置）`,
      errors,
      warnings
    }
  }
  if (warnings.length) {
    return { status: PREFLIGHT_WARN, paths, detail: warnings[0], warnings, errors: [] }
  }
  return {
    status: PREFLIGHT_OK,
    paths,
    detail: paths.length ? paths.join(", ") : "defaults only",
    warnings: [],
    errors: []
  }
}

function updateCheck(update) {
  if (!update) return { status: PREFLIGHT_OK, current: PACKAGE_VERSION, latest: null, detail: "not checked" }
  const latest = update.latest || null
  if (update.error) return { status: PREFLIGHT_OK, current: PACKAGE_VERSION, latest, detail: "check failed" }
  if (update.updateAvailable && latest) {
    return { status: PREFLIGHT_WARN, current: PACKAGE_VERSION, latest, detail: `${PACKAGE_VERSION} -> ${latest}` }
  }
  return { status: PREFLIGHT_OK, current: PACKAGE_VERSION, latest, detail: `${PACKAGE_VERSION} (latest)` }
}

/**
 * @returns {{status, checks, problems}} status 取最坏的一项
 */
export function buildPreflightReport({ configState, mcp, skills, update = null, fastIssues = null } = {}) {
  const checks = {
    config: configCheck(configState),
    provider: providerCheck(configState),
    fastModel: fastModelCheck(configState, fastIssues || fastModelIssues()),
    permission: {
      status: PREFLIGHT_OK,
      level: normalizePermissionLevel(configState?.config?.permission || {}),
      detail: normalizePermissionLevel(configState?.config?.permission || {})
    },
    mcp: mcpCheck(mcp),
    skills: skillCheck(skills),
    update: updateCheck(update)
  }

  const problems = Object.entries(checks)
    .filter(([, c]) => c.status !== PREFLIGHT_OK)
    .map(([name, c]) => ({ name, status: c.status, detail: c.detail }))

  const status = problems.some((p) => p.status === PREFLIGHT_FAIL)
    ? PREFLIGHT_FAIL
    : problems.length
      ? PREFLIGHT_WARN
      : PREFLIGHT_OK

  return { status, checks, problems }
}

const LABEL_WIDTH = 12

/** 单行一项，供 CLI 与 TUI 共用。 */
export function formatPreflightLines(report) {
  if (!report) return []
  const mark = { [PREFLIGHT_OK]: "ok  ", [PREFLIGHT_WARN]: "warn", [PREFLIGHT_FAIL]: "fail" }
  const order = ["config", "provider", "fastModel", "permission", "mcp", "skills", "update"]
  return order.map((name) => {
    const check = report.checks[name]
    if (!check) return ""
    const extra = name === "provider" && check.name
      ? `${check.name} ${check.model || "-"} · ${check.detail}`
      : check.detail
    return `  ${mark[check.status] || "?   "}  ${name.padEnd(LABEL_WIDTH)}${extra}`
  }).filter(Boolean)
}

/** 是否应该在启动时自动安装更新。默认只提示，需环境变量显式开启。 */
export function shouldAutoInstallUpdate(config = {}, env = process.env) {
  const flag = String(env.KKCODE_AUTO_UPDATE || "").toLowerCase()
  if (["1", "true", "yes", "on"].includes(flag)) return true
  if (["0", "false", "no", "off"].includes(flag)) return false
  return config?.update?.auto_install === true
}
