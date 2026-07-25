import test from "node:test"
import assert from "node:assert/strict"
import { createDegradationChain } from "../src/session/longagent-utils.mjs"

/**
 * 降级链在 0.4.x 是死的。
 *
 * apply() 只在策略生效时才 currentLevel++，而默认配置 fallback_model 为 null
 * 让第 0 档 switch_model 恒返回 false —— 级别永远停在 0，canDegrade() 恒真，
 * 后三档不可达，graceful_stop 永不触发，四处依赖它的 break 全部失效。
 * 同时 degradation.enabled 从未被任何代码读取。
 *
 * 这里锁死修复后的语义：级别无条件前进、单次调用内跳过不适用的档位、
 * enabled:false 真的能关掉。
 */

function freshCtx(overrides = {}) {
  return {
    model: "big-model",
    taskProgress: { t1: { status: "error" }, t2: { status: "completed" } },
    configState: { config: { agent: { longagent: { parallel: { max_concurrency: 4 } } } } },
    shouldStop: false,
    ...overrides
  }
}

test("默认配置（fallback_model 为 null）也能一路走到 graceful_stop", () => {
  // 0.4.x 在这个配置下永远停在 level 0，graceful_stop 不可达
  const chain = createDegradationChain({ skip_non_critical: true })
  const ctx = freshCtx()

  const first = chain.apply(ctx)
  assert.equal(first.applied, true)
  assert.equal(first.strategy, "reduce_scope", "switch_model 不可用时应跳过而不是卡住")
  assert.deepEqual(first.skipped, ["switch_model"])

  const second = chain.apply(ctx)
  assert.equal(second.strategy, "serial_mode")
  assert.equal(ctx.configState.config.agent.longagent.parallel.max_concurrency, 1)

  const third = chain.apply(ctx)
  assert.equal(third.strategy, "graceful_stop")
  assert.equal(third.applied, true)
  assert.equal(ctx.shouldStop, true)

  assert.equal(chain.canDegrade(), false, "四档用尽后不应再声称可以降级")
  const fourth = chain.apply(ctx)
  assert.equal(fourth.applied, false)
  assert.equal(fourth.exhausted, true)
})

test("每一档可用时按序生效，级别逐档前进", () => {
  const chain = createDegradationChain({ fallback_model: "small-model", skip_non_critical: true })
  const ctx = freshCtx()

  assert.equal(chain.level, 0)
  assert.equal(chain.apply(ctx).strategy, "switch_model")
  assert.equal(ctx.model, "small-model")
  assert.equal(chain.level, 1)
  assert.equal(chain.apply(ctx).strategy, "reduce_scope")
  assert.equal(chain.apply(ctx).strategy, "serial_mode")
  assert.equal(chain.apply(ctx).strategy, "graceful_stop")
  assert.equal(chain.level, 4)
})

test("单次调用可以连跳多个不适用的档位", () => {
  // fallback_model 缺省 -> switch_model 不可用
  // skip_non_critical 缺省 false -> reduce_scope 不可用
  // 没有 parallel 配置 -> serial_mode 不可用
  const chain = createDegradationChain({})
  const ctx = freshCtx({ configState: { config: { agent: { longagent: {} } } } })

  const only = chain.apply(ctx)
  assert.equal(only.strategy, "graceful_stop")
  assert.deepEqual(only.skipped, ["switch_model", "reduce_scope", "serial_mode"])
  assert.equal(ctx.shouldStop, true)
})

test("degradation.enabled 为 false 时整条链关闭", () => {
  const chain = createDegradationChain({ enabled: false, fallback_model: "small-model", skip_non_critical: true })
  const ctx = freshCtx()

  assert.equal(chain.enabled, false)
  assert.equal(chain.canDegrade(), false)

  const result = chain.apply(ctx)
  assert.equal(result.applied, false)
  assert.equal(result.disabled, true)
  assert.equal(ctx.model, "big-model", "关闭后不得改动模型")
  assert.equal(ctx.shouldStop, false, "关闭后不得置停止标志")
  assert.equal(chain.level, 0)
})

test("reduce_scope 只在真有可跳过的任务时才算生效", () => {
  const chain = createDegradationChain({ skip_non_critical: true })
  const ctx = freshCtx({ taskProgress: { t1: { status: "completed" } } })

  const result = chain.apply(ctx)
  assert.equal(result.strategy, "serial_mode", "没有失败任务可跳过时应继续下一档")
  assert.deepEqual(result.skipped, ["switch_model", "reduce_scope"])
})

test("reduce_scope 把失败与重试中的任务标记为跳过", () => {
  const chain = createDegradationChain({ skip_non_critical: true })
  const ctx = freshCtx({
    taskProgress: { a: { status: "error" }, b: { status: "retrying" }, c: { status: "completed" } }
  })

  assert.equal(chain.apply(ctx).strategy, "reduce_scope")
  assert.equal(ctx.taskProgress.a.status, "skipped")
  assert.equal(ctx.taskProgress.a.skipReason, "degradation_reduce_scope")
  assert.equal(ctx.taskProgress.b.status, "skipped")
  assert.equal(ctx.taskProgress.c.status, "completed", "已完成的任务不该被跳过")
})
