import test from "node:test"
import assert from "node:assert/strict"
import { isCommandLikeInput } from "../src/repl.mjs"

/**
 * `!` 前缀（shell 直通，0.7.5）必须被归类为「命令」而不是「给模型的话」。
 *
 * 这个判据有六个消费者（模式自动路由、agent transaction 清理、中断续跑合并、
 * longagent 补充需求…）—— 归类错了的话，`!npm test` 会被自动路由改写、
 * 或被拼进中断后的续跑提示里发给模型。
 */

test("`!命令` 是命令样输入，与 / 和 $ 同级", () => {
  assert.equal(isCommandLikeInput("!npm test"), true)
  assert.equal(isCommandLikeInput("  !ls -la"), true, "前导空白要容忍 —— 判据是 trimStart 后的")
  assert.equal(isCommandLikeInput("/help"), true)
  assert.equal(isCommandLikeInput("$review"), true)
})

test("`!=` 与孤立的 `!` 不是命令 —— 用户可能在写数学或感叹", () => {
  assert.equal(isCommandLikeInput("!= null 是什么意思"), false)
  assert.equal(isCommandLikeInput("!"), false)
  assert.equal(isCommandLikeInput("! 后面带空格的感叹"), false)
  assert.equal(isCommandLikeInput("普通的一句话"), false)
})
