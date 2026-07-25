import test from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { formatAlert } from "../src/ui/activity-renderer.mjs"

/**
 * 告警事件的 payload 契约。
 *
 * activity-renderer 的 formatAlert 只读 payload.message，而 0.4.x 有一半的
 * emit 点根本没有这个字段：blueprint_parse_retry 用 errors、stuck_warning 用
 * reason、semantic_force_exit 用 error、budget_breaker 只有数字、
 * skill_* 只有文件名。结果是终端上出现一行 `⚠ alert [stuck_warning]`，
 * 后面空空如也 —— 告警了，但没说为什么。
 *
 * 这是个静态扫描，粗糙，但正好拦得住「下一个漏网的 emit 点」——
 * 这类漏洞靠运行时测试是抓不到的，因为没人会为每个告警分支写用例。
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src")
const EMIT_PATTERN = /type:\s*EVENT_TYPES\.LONGAGENT_ALERT/g
const WINDOW = 600

async function* walkMjs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkMjs(full)
    else if (entry.name.endsWith(".mjs")) yield full
  }
}

test("每个 LONGAGENT_ALERT 发射点的 payload 都带 message", async () => {
  const offenders = []
  let sites = 0

  for await (const file of walkMjs(SRC)) {
    const source = await readFile(file, "utf8")
    for (const match of source.matchAll(EMIT_PATTERN)) {
      sites += 1
      const window = source.slice(match.index, match.index + WINDOW)
      if (!/\bmessage\s*:/.test(window)) {
        const line = source.slice(0, match.index).split("\n").length
        offenders.push(`${path.relative(SRC, file)}:${line}`)
      }
    }
  }

  assert.ok(sites >= 10, `只扫到 ${sites} 个发射点，正则可能失效了`)
  assert.deepEqual(offenders, [],
    `以下 LONGAGENT_ALERT 发射点缺少 message，用户会看到一条没有原因的告警：\n  ${offenders.join("\n  ")}`)
})

test("formatAlert 对历史 payload 有兜底", () => {
  // 事件日志里存着 0.4.x 写下的旧事件，回放时不能变成空白告警
  assert.match(formatAlert("stuck_warning", undefined, { reason: "tool_cycle_detected" }), /tool_cycle_detected/)
  assert.match(formatAlert("semantic_force_exit", "", { error: "TypeError: x is not a function" }), /TypeError/)
  assert.match(formatAlert("blueprint_parse_retry", null, { errors: ["no stages", "bad json"] }), /no stages; bad json/)
  assert.match(formatAlert("plan_defect", "依赖环"), /依赖环/)
  // message 优先于兜底字段
  assert.match(formatAlert("k", "说清楚了", { reason: "别用我" }), /说清楚了/)
  assert.doesNotMatch(formatAlert("k", "说清楚了", { reason: "别用我" }), /别用我/)
  // 什么都没有时不炸
  assert.match(formatAlert("k"), /\[k\]/)
})
