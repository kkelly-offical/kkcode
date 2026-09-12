/**
 * `runUsabilityGates()` 返回形状的唯一读取点。
 *
 * 契约（见 usability-gates.mjs 的 runUsabilityGates 返回语句）：
 *
 *   { allPass:  boolean,
 *     gates:    { build, test, review, health, budget, smoke },  // 每个 { enabled, status, reason, output? }
 *     failures: [{ gate, status, reason, output }] }
 *
 * 为什么要专门为「读一个字段」建一个模块：
 *
 * 0.4.2 的 stage-objective.mjs 写的是 `gates.results?.build || gates.build`，
 * 两条路径都不存在。取到 undefined 之后 `{}` 既通过了「门禁生效」过滤
 * （`{}.enabled !== false` 与 `{}.status !== "disabled"` 都为真），又在下一步
 * 被判为失败（`undefined !== "pass"`）—— 于是文件齐备、门禁全过时
 * verifyStageObjective 仍然返回 unmet，OBJECTIVE_MET 在生产路径上不可达。
 * 而单元测试因为 mock 了一个不存在的 `{ results: {...} }` 形状，八个用例全绿。
 *
 * 根因不是写错了一行，而是**读取点没有契约，错了也没人知道**。所以这里
 * 宁可炸，不可静默：形状不对就抛，调用方捕获后降级为 unknown 并发一条
 * gate_contract_drift 告警，而不是默默地把「没做完」当成「做完了」。
 *
 * 配套：test/usability-gates-contract.test.mjs 用真函数锁死这份契约，
 * test/helpers/gate-fixture.mjs 是全仓门禁替身的唯一构造器。
 */

/**
 * 门禁名称与顺序。runUsabilityGates 的 gates 字段恰好含这六个键。
 *
 * 0.7.0 加入 smoke：前五道全是静态检查（编译过、测试过、review 过、存储健康、
 * 预算够），没有一道会把产物真的跑起来 —— 接不住「编译过了但一启动就崩」。
 */
export const GATE_NAMES = Object.freeze(["build", "test", "review", "health", "budget", "smoke"])

/** 形状漂移。继承 TypeError，所以 assert.throws(fn, TypeError) 仍然成立。 */
export class GateContractError extends TypeError {
  constructor(message) {
    super(message)
    this.name = "GateContractError"
  }
}

/**
 * 从 runUsabilityGates 的结果里取一个门禁。
 * @returns {{enabled?: boolean, status: string, reason?: string, output?: string}|null}
 *   门禁不存在时返回 null；**结果形状不对时抛 GateContractError**。
 */
export function readGate(gateResult, name) {
  if (!gateResult || typeof gateResult !== "object") return null
  const gates = gateResult.gates
  if (!gates || typeof gates !== "object") {
    const actual = Object.keys(gateResult).join(", ") || "(空对象)"
    throw new GateContractError(
      `runUsabilityGates() 的结果没有 .gates（实际键: ${actual}）—— ` +
      "门禁返回形状变了，请同步更新 src/session/gate-contract.mjs 的 readGate()"
    )
  }
  return gates[name] || null
}

/** 只有 pass 与 not_applicable 算通过。与 usability-gates 的判定共用同一份定义。 */
export function isPassingGateStatus(status) {
  return status === "pass" || status === "not_applicable"
}

/**
 * 这个门禁是否参与判定。禁用的门禁既不算通过也不算失败 —— 它没有发言权，
 * 调用方需要据此决定「无人可问」时该报 unknown 而不是 met。
 */
export function isDecisiveGate(gate) {
  return Boolean(gate) && gate.enabled !== false && gate.status !== "disabled"
}
