import { stat as statFs, readFile } from "node:fs/promises"
import path from "node:path"
import { readGate, isDecisiveGate, isPassingGateStatus } from "./gate-contract.mjs"
import { runGateCommand, outputSnippet } from "./usability-gates.mjs"
import { checkBashAllowed } from "../permission/exec-policy.mjs"
import {
  CRITERION_PASS, CRITERION_FAIL, CRITERION_UNKNOWN, CRITERION_MANUAL
} from "./goal-model.mjs"

/**
 * 目标核验器：逐条执行判据，聚合出「目标达成了吗」的诚实答案。
 *
 * 聚合规则刻意保守：
 *   - manual 未确认 > 0            → blocked_manual（人不点头就不算完）
 *   - blocking 里有 fail           → unmet
 *   - blocking 里有 unknown        → unknown —— **绝不 met**。「无法证明完成」
 *     与「已完成」是两回事，0.4.2 的事故正是把前者错报成了后者的反面。
 *   - blocking 全 pass 且确实评估过 → met
 *
 * command 类判据来自 LLM 生成的计划，是新的任意命令执行面，三层防护：
 *   1. exec-policy 闸门拒绝 → 判据记 **fail**（不是跳过 —— 被禁的判据命令是
 *      计划缺陷，必须让用户看见）
 *   2. 不在 allowlist → 降级为 manual（"请手动执行"）。降级而非拒绝是包容性，
 *      降级到 manual 而非 pass 是安全性。
 *   3. 执行走 runGateCommand：shell:false、超时 kill、输出采集 —— 绝不裸 spawn。
 */

export const GOAL_MET = "met"
export const GOAL_UNMET = "unmet"
export const GOAL_UNKNOWN = "unknown"
export const GOAL_BLOCKED_MANUAL = "blocked_manual"

const DEFAULT_COMMAND_ALLOWLIST = Object.freeze([
  "node", "npm", "npx", "pnpm", "yarn", "python", "python3", "pytest",
  "go", "cargo", "make", "tsc", "eslint", "jest", "vitest", "mocha", "git"
])
const DEFAULT_COMMAND_TIMEOUT_MS = 120000

function criteriaConfig(config) {
  return config?.agent?.longagent?.ultra?.criteria || {}
}

export function commandAllowlist(config) {
  const configured = criteriaConfig(config)?.command_allowlist
  return Array.isArray(configured) && configured.length ? configured.map(String) : DEFAULT_COMMAND_ALLOWLIST
}

/**
 * 执行一条判据。
 * @returns {{id, kind, text, severity, status, reason, evidence, durationMs}}
 */
export async function verifyCriterion(criterion, ctx = {}) {
  const started = Date.now()
  const base = {
    id: criterion.id,
    kind: criterion.kind,
    text: criterion.text,
    severity: criterion.severity || "blocking",
    evidence: {}
  }
  const done = (status, reason, evidence = {}) => ({
    ...base, status, reason, evidence, durationMs: Date.now() - started
  })

  // manual 的判定在第一行返回，不进入任何自动判定分支 —— 三层防线之一，
  // 另两层在 verifyGoal 的聚合与 property 测试里。
  if (criterion.kind === "manual") {
    if (ctx.manualConfirmed?.has?.(criterion.id)) {
      return done(CRITERION_PASS, "用户已确认", { confirmedBy: "user" })
    }
    return done(CRITERION_MANUAL, criterion.spec?.question || criterion.text)
  }

  const cwd = ctx.cwd || process.cwd()
  const statFn = ctx.deps?.stat || statFs
  const readFn = ctx.deps?.readFile || readFile
  const runFn = ctx.deps?.runGateCommand || runGateCommand

  try {
    switch (criterion.kind) {
      case "file_exists": {
        const target = path.resolve(cwd, criterion.spec.path)
        try {
          const info = await statFn(target)
          const bytes = Number(info.size) || 0
          if (info.isFile() && bytes >= criterion.spec.minBytes) {
            return done(CRITERION_PASS, `${criterion.spec.path} 存在（${bytes} 字节）`, { path: criterion.spec.path, bytes })
          }
          return done(CRITERION_FAIL, `${criterion.spec.path} ${info.isFile() ? `只有 ${bytes} 字节` : "不是文件"}`, { path: criterion.spec.path, bytes })
        } catch {
          return done(CRITERION_FAIL, `${criterion.spec.path} 不存在`, { path: criterion.spec.path })
        }
      }

      case "content_match": {
        const target = path.resolve(cwd, criterion.spec.path)
        let content
        try {
          content = await readFn(target, "utf8")
        } catch {
          return done(CRITERION_FAIL, `${criterion.spec.path} 不存在或不可读`, { path: criterion.spec.path })
        }
        let matched
        try {
          matched = new RegExp(criterion.spec.pattern, criterion.spec.flags || "").test(content)
        } catch (err) {
          return done(CRITERION_UNKNOWN, `判据的正则本身非法：${err.message}`, { pattern: criterion.spec.pattern })
        }
        const wanted = criterion.spec.negate ? !matched : matched
        return wanted
          ? done(CRITERION_PASS, `${criterion.spec.path} ${criterion.spec.negate ? "未" : ""}匹配 /${criterion.spec.pattern}/`, { path: criterion.spec.path })
          : done(CRITERION_FAIL, `${criterion.spec.path} ${criterion.spec.negate ? "意外匹配" : "未匹配"} /${criterion.spec.pattern}/`, { path: criterion.spec.path })
      }

      case "command_exit":
      case "test_pass": {
        const argv = [criterion.spec.command, ...(criterion.spec.args || [])]
        const commandLine = argv.join(" ")

        // 第 2 层：allowlist（只比 argv[0] 的 basename）
        const head = path.basename(String(criterion.spec.command || ""))
        if (!commandAllowlist(ctx.config).includes(head)) {
          return done(
            CRITERION_MANUAL,
            `命令不在判据允许列表中，请手动执行并确认：\`${commandLine}\``,
            { command: commandLine, downgraded: "not_in_allowlist" }
          )
        }
        // 第 1 层：exec-policy 闸门。被禁 = 计划缺陷 = fail，让用户看见。
        //
        // approvalLevel: 有意不传。这里判定的是**验收判据**里声明的命令，
        // 而一条会 commit/push 的判据本身就是错的 —— 它不该因为用户开了
        // YOLO 就变成合理的。放开审批档是为了「不打断你干活」，不是为了
        // 让错误的验收标准通过。
        const policy = checkBashAllowed(commandLine, ctx.config || {})
        if (policy && policy.allowed === false) {
          return done(CRITERION_FAIL, `判据命令被执行策略拒绝：${policy.reason}`, { command: commandLine })
        }
        // 第 3 层：受控执行
        const timeoutMs = Number(criterion.spec.timeoutMs)
          || Number(criteriaConfig(ctx.config).command_timeout_ms)
          || DEFAULT_COMMAND_TIMEOUT_MS
        // allow_shell（默认 false）：判据命令来自 LLM 生成的计划，默认绝不过
        // shell；显式打开才允许 shell 解释（需要管道/通配的判据）
        const allowShell = criteriaConfig(ctx.config).allow_shell === true
        const result = await runFn({ command: criterion.spec.command, args: criterion.spec.args || [], cwd, shell: allowShell, timeoutMs })
        const evidence = {
          command: commandLine,
          exitCode: result.code,
          timedOut: result.timedOut === true,
          outputSnippet: outputSnippet(result)
        }
        if (result.timedOut) {
          return done(CRITERION_FAIL, `\`${commandLine}\` 超时（${Math.round(timeoutMs / 1000)}s）`, evidence)
        }
        const expect = criterion.spec.expect ?? 0
        return result.code === expect
          ? done(CRITERION_PASS, `\`${commandLine}\` 退出码 ${result.code}`, evidence)
          : done(CRITERION_FAIL, `\`${commandLine}\` 退出码 ${result.code}（期望 ${expect}）`, evidence)
      }

      case "gate_pass": {
        let gate
        try {
          gate = readGate(ctx.gateResult, criterion.spec.gate)
        } catch (err) {
          return done(CRITERION_UNKNOWN, `门禁契约漂移：${err.message}`, { gate: criterion.spec.gate })
        }
        if (!gate) return done(CRITERION_UNKNOWN, `本轮没有 ${criterion.spec.gate} 门禁的结果`, { gate: criterion.spec.gate })
        if (!isDecisiveGate(gate)) return done(CRITERION_UNKNOWN, `${criterion.spec.gate} 门禁被禁用，无发言权`, { gate: criterion.spec.gate })
        return isPassingGateStatus(gate.status)
          ? done(CRITERION_PASS, `${criterion.spec.gate} 门禁 ${gate.status}`, { gate: criterion.spec.gate, status: gate.status })
          : done(CRITERION_FAIL, `${criterion.spec.gate} 门禁失败：${gate.reason || gate.status}`, {
              gate: criterion.spec.gate, status: gate.status, outputSnippet: gate.output || ""
            })
      }

      default:
        return done(CRITERION_UNKNOWN, `未知判据类型 ${criterion.kind}`)
    }
  } catch (err) {
    // 判据执行器自身出错 —— 报 unknown，绝不因为「查不了」就当成过了
    return done(CRITERION_UNKNOWN, `判据执行出错：${String(err?.message || err).slice(0, 200)}`)
  }
}

function aggregate(results) {
  const blocking = results.filter((r) => r.severity !== "advisory")
  const manual = blocking.filter((r) => r.status === CRITERION_MANUAL)
  const failed = blocking.filter((r) => r.status === CRITERION_FAIL)
  const unknown = blocking.filter((r) => r.status === CRITERION_UNKNOWN)
  const passed = blocking.filter((r) => r.status === CRITERION_PASS)

  let status
  if (manual.length > 0) status = GOAL_BLOCKED_MANUAL
  else if (failed.length > 0) status = GOAL_UNMET
  else if (unknown.length > 0) status = GOAL_UNKNOWN
  else if (passed.length > 0) status = GOAL_MET
  else status = GOAL_UNKNOWN // 一条 blocking 判据都没有 —— 无从证明

  return { status, passed: passed.length, failed: failed.length, unknown: unknown.length, manual: manual.length }
}

/**
 * 核验整棵目标树。
 *
 * @param {object} params
 * @param {object} params.goal          normalizeGoal 产出的目标（可含 subGoals）
 * @param {object} params.gateResult    本轮 runUsabilityGates 的结果，外部注入以免重复跑 build/test
 * @param {Set<string>} params.manualConfirmed 用户已确认的 manual 判据 id
 * @returns {{status, results, subGoals, passed, failed, unknown, manual, evaluatedAt}}
 *
 * 子目标聚合：root met = 全部非 optional 子目标 met **且** root 自身判据全过；
 * 任一子目标 blocked_manual → root blocked_manual。optional 子目标不影响 root，
 * 但结果保留 —— 报告必须展示它们。
 */
export async function verifyGoal({ goal, cwd, config, gateResult = null, manualConfirmed = null, deps = {} } = {}) {
  const evaluatedAt = new Date().toISOString()
  if (!goal) {
    return { status: GOAL_UNKNOWN, results: [], subGoals: [], passed: 0, failed: 0, unknown: 0, manual: 0, evaluatedAt }
  }
  const ctx = { cwd, config, gateResult, manualConfirmed, deps }

  const results = []
  for (const criterion of goal.criteria || []) {
    results.push(await verifyCriterion(criterion, ctx))
  }

  const subGoals = []
  for (const sub of goal.subGoals || []) {
    const subResults = []
    for (const criterion of sub.criteria || []) {
      subResults.push(await verifyCriterion(criterion, ctx))
    }
    const subAgg = aggregate(subResults)
    subGoals.push({
      goalId: sub.goalId, title: sub.title, optional: sub.optional === true,
      stageIds: sub.stageIds || [], status: subAgg.status, results: subResults,
      passed: subAgg.passed, failed: subAgg.failed, unknown: subAgg.unknown, manual: subAgg.manual
    })
  }

  const rootAgg = aggregate(results)
  const hasRootCriteria = (goal.criteria || []).length > 0
  let status = rootAgg.status

  if (subGoals.length) {
    const required = subGoals.filter((s) => !s.optional)
    // root 没有自身判据时，它的聚合结果是「无从判定」——那不该拖累子目标的结论
    const rootBlocks = (want) => hasRootCriteria && rootAgg.status === want
    if (subGoals.some((s) => s.status === GOAL_BLOCKED_MANUAL) || rootBlocks(GOAL_BLOCKED_MANUAL)) {
      status = GOAL_BLOCKED_MANUAL
    } else if (required.some((s) => s.status === GOAL_UNMET) || rootBlocks(GOAL_UNMET)) {
      status = GOAL_UNMET
    } else if (required.some((s) => s.status === GOAL_UNKNOWN) || rootBlocks(GOAL_UNKNOWN)) {
      status = GOAL_UNKNOWN
    } else if (!required.length || required.every((s) => s.status === GOAL_MET)) {
      status = hasRootCriteria ? rootAgg.status : GOAL_MET
    }
  }

  const totals = [...results, ...subGoals.flatMap((s) => s.results)].filter((r) => r.severity !== "advisory")
  return {
    status,
    results,
    subGoals,
    passed: totals.filter((r) => r.status === CRITERION_PASS).length,
    failed: totals.filter((r) => r.status === CRITERION_FAIL).length,
    unknown: totals.filter((r) => r.status === CRITERION_UNKNOWN).length,
    manual: totals.filter((r) => r.status === CRITERION_MANUAL).length,
    evaluatedAt
  }
}
