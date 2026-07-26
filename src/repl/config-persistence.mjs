/**
 * REPL 侧的配置落盘。
 *
 * 这一簇（读、写、按作用域选路径、合并）被两层共用：命令层的 `/permission save`
 * 与 `/permission forget`，以及 TUI 层权限提示里的「Always Allow」。此前它们都
 * 挤在 repl.mjs 顶部，于是「配置写在哪个文件」这个决定散落在四处调用点里。
 *
 * 作用域的选择是有意的，不是默认值：
 *   - 学到的授权规则**只写用户级**。项目级会把授权记录提交进仓库（用户的
 *     .gitignore 未必忽略 .kkcode/），等于把「我允许过这条命令」共享给所有人。
 *   - `/permission save` 允许指定 project 或 user，因为那是显式的落盘动作。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import YAML from "yaml"
import { userConfigCandidates, projectConfigCandidates } from "../storage/paths.mjs"
import { mergeConfigObject } from "../config/merge.mjs"
import { appendLearnedRule, buildLearnedRule } from "../permission/learned-rules.mjs"

export function parseConfigByPath(filePath, raw) {
  if (filePath.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

export function stringifyConfigByPath(filePath, data) {
  if (filePath.endsWith(".json")) return JSON.stringify(data, null, 2) + "\n"
  return YAML.stringify(data)
}

export function pickConfigPathForScope(scope, source, cwd = process.cwd()) {
  if (scope === "user") return source?.userPath || userConfigCandidates()[0]
  if (scope === "project") return source?.projectPath || projectConfigCandidates(cwd)[0]
  return null
}

export async function readConfigFile(target) {
  try {
    const raw = await readFile(target, "utf8")
    return parseConfigByPath(target, raw) || {}
  } catch {
    return {}
  }
}

export async function writeConfigFile(target, data) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, stringifyConfigByPath(target, data), "utf8")
}

/**
 * 把一次「Always Allow」写入用户级配置。
 *
 * 刻意选用户级而非项目级：用户仓库的 .gitignore 未必忽略 .kkcode/，
 * 项目级会把授权记录提交出去。规则带 workspace 限定生效范围。
 */
export async function persistLearnedGrant({ ctx, tool, pattern, command, workspace }) {
  const rule = buildLearnedRule({ tool, pattern, command, workspace: workspace || process.cwd() })
  if (!rule) return { added: false, reason: "invalid", rule: null }

  const target = pickConfigPathForScope("user", ctx.configState?.source, process.cwd())
  if (!target) return { added: false, reason: "no_target", rule }

  const existing = await readConfigFile(target)
  const currentRules = existing?.permission?.rules
  const outcome = appendLearnedRule(currentRules, rule)
  if (!outcome.added) return { added: false, reason: outcome.reason, rule }

  await writeConfigFile(target, {
    ...existing,
    permission: { ...(existing.permission || {}), rules: outcome.rules }
  })

  // 让本次会话立即生效，无需重启
  const live = ctx.configState.config.permission || (ctx.configState.config.permission = {})
  live.rules = appendLearnedRule(live.rules, rule).rules
  ctx.configState.source.userPath = target
  return { added: true, reason: "added", rule }
}

export async function persistPermissionConfig({ scope, ctx, values }) {
  const source = ctx.configState?.source || {}
  const target = pickConfigPathForScope(scope, source, process.cwd())
  if (!target) throw new Error(`unable to resolve ${scope} config path`)

  const existing = await readConfigFile(target)
  const merged = mergeConfigObject(existing, { permission: { ...values } })
  await writeConfigFile(target, merged)

  if (scope === "user") {
    ctx.configState.source.userPath = target
    ctx.configState.source.userDir = dirname(target)
    ctx.configState.source.userRaw = merged
  } else if (scope === "project") {
    ctx.configState.source.projectPath = target
    ctx.configState.source.projectDir = dirname(target)
    ctx.configState.source.projectRaw = merged
  }

  return target
}
