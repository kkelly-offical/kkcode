import { GATE_NAMES, isPassingGateStatus } from "../../src/session/gate-contract.mjs"

/**
 * 全仓门禁替身的**唯一**构造器。
 *
 * 手写的 gate mock 是 0.4.2 那次事故的根因：stage-objective 的测试各自
 * 编了一个 `{ results: { build: {...} } }` 形状，这个形状在生产里从不存在，
 * 于是被测代码读错了字段、判据彻底失效，八个用例照样全绿。
 *
 * 规则：任何需要伪造 runUsabilityGates 结果的测试都必须走这个工厂。
 * test/usability-gates-contract.test.mjs 会拿真函数的输出与它逐键比对 ——
 * 想造一个假形状就得改这里，改了契约测试立刻红。
 *
 * @param {Record<string, string>} statuses 门禁名 -> status（pass / fail /
 *   not_applicable / disabled / warn）。未列出的门禁默认 pass。
 * @param {{reasons?: Record<string,string>, outputs?: Record<string,string>}} extra
 */
export function makeGateResult(statuses = {}, { reasons = {}, outputs = {} } = {}) {
  const gates = {}
  for (const name of GATE_NAMES) {
    const status = statuses[name] || "pass"
    if (status === "disabled") {
      gates[name] = { enabled: false, status: "disabled", reason: reasons[name] || `${name} gate disabled` }
      continue
    }
    const gate = { enabled: true, status, reason: reasons[name] || `${name} gate ${status}` }
    if (outputs[name]) gate.output = outputs[name]
    gates[name] = gate
  }

  const failures = Object.entries(gates)
    .filter(([, gate]) => gate.enabled !== false && !isPassingGateStatus(gate.status))
    .map(([gate, result]) => ({
      gate,
      status: result.status,
      reason: result.reason,
      output: result.output || ""
    }))

  return { allPass: failures.length === 0, gates, failures }
}

/** 便捷：把工厂包成一个 runUsabilityGates 替身。 */
export function makeGateRunner(statuses = {}, extra = {}) {
  return async () => makeGateResult(statuses, extra)
}
