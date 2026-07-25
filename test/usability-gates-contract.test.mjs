import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * 门禁返回形状的契约测试。
 *
 * 0.4.2 的 stage-objective 读 `gates.results.build`，而真实结构是
 * `gates.gates.build`；两条路径都取到 undefined，判据彻底失效，而八个
 * 单测因为 mock 了那个不存在的形状全绿。这个文件就是为了让同类事故
 * 不能再发生：
 *
 *   1. 拿**真函数**的输出锁死顶层结构与门禁集合
 *   2. 断言 test/helpers/gate-fixture.mjs 的替身与真实输出逐键同构
 *   3. 断言旧的错误形状会**抛异常**而不是静默取空
 *
 * 环境隔离：门禁会读写用户级目录（gate-preferences.json、session store），
 * 必须在 import 之前把 KKCODE_HOME 指到临时目录 —— 0.4.1 的 e2e 就是因为
 * 读到了开发机上的真实配置才在 CI 上翻车。所以这里用动态 import。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-gate-home-"))
const tmpCwd = await mkdtemp(path.join(os.tmpdir(), "kkcode-gate-cwd-"))
process.env.KKCODE_HOME = tmpHome

const { runUsabilityGates } = await import("../src/session/usability-gates.mjs")
const { readGate, isDecisiveGate, isPassingGateStatus, GATE_NAMES, GateContractError } =
  await import("../src/session/gate-contract.mjs")
const { makeGateResult } = await import("./helpers/gate-fixture.mjs")

const ALL_DISABLED = {
  agent: {
    longagent: {
      usability_gates: {
        build: { enabled: false }, test: { enabled: false }, review: { enabled: false },
        health: { enabled: false }, budget: { enabled: false }
      }
    }
  }
}

// 空目录里跑 build/test：没有 package.json、没有 test/ 目录，两者都应判
// not_applicable，不会真的去 spawn npm。
const BUILD_TEST_ONLY = {
  agent: {
    longagent: {
      usability_gates: {
        build: { enabled: true }, test: { enabled: true }, review: { enabled: false },
        health: { enabled: false }, budget: { enabled: false }
      }
    }
  }
}

test.after(async () => {
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  await rm(tmpCwd, { recursive: true, force: true }).catch(() => {})
})

test("runUsabilityGates 的返回形状是被 stage-objective 依赖的契约", async () => {
  const real = await runUsabilityGates({ sessionId: "contract", config: ALL_DISABLED, cwd: tmpCwd })

  assert.deepEqual(Object.keys(real).sort(), ["allPass", "failures", "gates"],
    "顶层结构变了 —— readGate() 与所有消费方都要同步更新")
  assert.deepEqual(Object.keys(real.gates).sort(), [...GATE_NAMES].sort(),
    "门禁集合变了 —— gate-contract.mjs 的 GATE_NAMES 要同步")
  assert.ok(Array.isArray(real.failures))

  for (const [name, gate] of Object.entries(real.gates)) {
    assert.ok(gate && typeof gate === "object", `${name} 必须是对象`)
    assert.ok("status" in gate, `${name} 必须有 status`)
    assert.ok("enabled" in gate || gate.status === "disabled", `${name} 必须能判断是否生效`)
  }

  // readGate 走的就是这条路径
  assert.equal(readGate(real, "build"), real.gates.build)
  assert.equal(readGate(real, "nonexistent"), null)
})

test("门禁全部禁用时不参与判定，且 allPass 为真", async () => {
  const real = await runUsabilityGates({ sessionId: "contract", config: ALL_DISABLED, cwd: tmpCwd })
  assert.equal(real.allPass, true)
  assert.equal(real.failures.length, 0)
  for (const name of GATE_NAMES) {
    assert.equal(isDecisiveGate(readGate(real, name)), false, `${name} 被禁用后不应有发言权`)
  }
})

test("空项目里 build/test 判 not_applicable 而非失败", async () => {
  const real = await runUsabilityGates({ sessionId: "contract", config: BUILD_TEST_ONLY, cwd: tmpCwd })
  assert.equal(readGate(real, "build").status, "not_applicable")
  assert.equal(readGate(real, "test").status, "not_applicable")
  assert.equal(isPassingGateStatus("not_applicable"), true)
  assert.equal(real.allPass, true, "not_applicable 算通过")
})

test("测试替身必须与真实形状同构", async () => {
  const real = await runUsabilityGates({ sessionId: "contract", config: ALL_DISABLED, cwd: tmpCwd })
  const fake = makeGateResult({ build: "pass", test: "pass" })

  assert.deepEqual(Object.keys(fake).sort(), Object.keys(real).sort(),
    "替身的顶层键与真实返回不一致 —— 这正是 0.4.2 事故的形态")
  assert.deepEqual(Object.keys(fake.gates).sort(), Object.keys(real.gates).sort())
  for (const name of GATE_NAMES) {
    assert.ok("status" in fake.gates[name])
    assert.ok("enabled" in fake.gates[name] || fake.gates[name].status === "disabled")
  }
})

test("替身能表达失败并带上 output", () => {
  const fake = makeGateResult({ test: "fail" }, { outputs: { test: "2 tests failing | at foo.mjs:3" } })
  assert.equal(fake.allPass, false)
  assert.equal(fake.failures.length, 1)
  assert.equal(fake.failures[0].gate, "test")
  assert.match(fake.failures[0].output, /2 tests failing/)
  assert.equal(readGate(fake, "test").status, "fail")
})

test("旧的 {results:{}} 形状必须抛而不是静默取空", () => {
  // 0.4.2 的判据就是被这个形状喂成了「永远 unmet」
  assert.throws(() => readGate({ results: { build: { status: "pass" } } }, "build"), GateContractError)
  assert.throws(() => readGate({ results: { build: { status: "pass" } } }, "build"), TypeError)
  assert.throws(() => readGate({ allPass: true }, "build"), /没有 \.gates/)
  // null / undefined 是「没跑门禁」，不是形状错误
  assert.equal(readGate(null, "build"), null)
  assert.equal(readGate(undefined, "build"), null)
})
