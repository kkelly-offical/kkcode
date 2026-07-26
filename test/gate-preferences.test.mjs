import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GATE_NAMES } from "../src/session/gate-contract.mjs"

/**
 * 门禁偏好是**用户级**的（~/.kkcode/gate-preferences.json），写坏一次会影响
 * 该用户的所有项目、所有会话，而且用户不会察觉 —— 只会觉得 Ultra 忽然变得
 * 很容易「完成」。
 *
 * 0.4.x 的事故链：非交互环境下也去询问 → askQuestionInteractive 返回空串 →
 * parseGateSelection 把空串解析成「全部关闭」→ saveGatePreferences 永久落盘。
 *
 * 这里锁住三道防线：解析层不再把「没答」当成「都不要」、存储层能识别并自愈
 * 已经被写坏的记录、以及 hasPromptHandler 必须实时反映当前状态。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-gateprefs-"))
process.env.KKCODE_HOME = tmpHome
const PREFS = path.join(tmpHome, "gate-preferences.json")

const { parseGateSelection, saveGatePreferences, getGatePreferences, hasGatePreferences } =
  await import("../src/session/usability-gates.mjs")
const { hasPromptHandler, setQuestionPromptHandler } =
  await import("../src/tool/question-prompt.mjs")

test.after(async () => {
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

test("解析不出门禁选择时返回 null，而不是「全部关闭」", () => {
  // 这三种都是「没问出结果」，0.4.x 全部解析成 5 个 false 并落盘
  assert.equal(parseGateSelection(""), null)
  assert.equal(parseGateSelection("   "), null)
  assert.equal(parseGateSelection("好的，我明白了"), null)
  assert.equal(parseGateSelection(undefined), null)
})

test("用户明确表达时照常解析", () => {
  // 从 GATE_NAMES 推导：手写清单在新增门禁时会失败，而这条用例要锁的是
  // 「all 表示全开、none 表示全关」，不是门禁有几道。
  const allOn = Object.fromEntries(GATE_NAMES.map((name) => [name, true]))
  const allOff = Object.fromEntries(GATE_NAMES.map((name) => [name, false]))
  assert.deepEqual(parseGateSelection("all"), allOn)
  // 「none」是用户真的说了不要，与「没答」必须区分开
  assert.deepEqual(parseGateSelection("none"), allOff)
  const partial = parseGateSelection("build, test")
  assert.equal(partial.build, true)
  assert.equal(partial.test, true)
  assert.equal(partial.review, false)
})

test("落盘的偏好带 explicit 标记，读回时不外泄该字段", async () => {
  await saveGatePreferences({ build: true, test: true, review: false, health: false, budget: false })

  const raw = JSON.parse(await readFile(PREFS, "utf8"))
  assert.equal(raw.explicit, true, "必须留下「这是用户真的选过的」证据")

  const loaded = await getGatePreferences()
  assert.deepEqual(Object.keys(loaded).sort(), ["budget", "build", "health", "review", "test"])
  assert.equal(loaded.explicit, undefined, "标记不该被当成一个门禁传给调用方")
  assert.equal(loaded.build, true)
})

test("0.4.x 写坏的全 false 记录被识别为事故并自愈", async () => {
  // 模拟 0.4.x 的产物：五个全 false，没有 explicit 标记
  await mkdir(path.dirname(PREFS), { recursive: true })
  await writeFile(PREFS, JSON.stringify({
    build: false, test: false, review: false, health: false, budget: false
  }), "utf8")

  // 缓存会挡住重新读盘，用独立的模块实例验证
  const fresh = await import(`../src/session/usability-gates.mjs?accident=${Date.now()}`)
  assert.equal(await fresh.hasGatePreferences(), false,
    "被空答案写坏的记录应当被忽略，让用户重新被问一次")
  assert.equal(await fresh.getGatePreferences(), null)
})

test("自愈判定不因新增门禁而失效", async () => {
  // 0.7.0 加入 smoke 时，判定写成 GATE_NAMES.every(g => prefs[g] === false)
  // 的版本对 0.4.x 的五键记录**恰好失效了** —— prefs.smoke 是 undefined 而非
  // false。一个随枚举增长而静默失效的安全判定，比没有更危险。
  await mkdir(path.dirname(PREFS), { recursive: true })

  // 全量键、全 false：仍须识别为事故
  await writeFile(PREFS, JSON.stringify(
    Object.fromEntries(GATE_NAMES.map((name) => [name, false]))
  ), "utf8")
  const full = await import(`../src/session/usability-gates.mjs?full=${Date.now()}`)
  assert.equal(await full.hasGatePreferences(), false, "全量键全 false 仍是事故")

  // 有一项为 true：这是真实选择，不该被自愈吃掉
  await writeFile(PREFS, JSON.stringify({
    ...Object.fromEntries(GATE_NAMES.map((name) => [name, false])),
    build: true
  }), "utf8")
  const mixed = await import(`../src/session/usability-gates.mjs?mixed=${Date.now()}`)
  assert.equal(await mixed.hasGatePreferences(), true, "只要有一项开启就是真实选择")
})

test("用户主动选择 none 时留下的记录会被尊重", async () => {
  await writeFile(PREFS, JSON.stringify({
    build: false, test: false, review: false, health: false, budget: false, explicit: true
  }), "utf8")

  const fresh = await import(`../src/session/usability-gates.mjs?explicit=${Date.now()}`)
  assert.equal(await fresh.hasGatePreferences(), true, "有 explicit 标记就是用户的真实选择")
  const prefs = await fresh.getGatePreferences()
  assert.equal(prefs.build, false)
})

test("hasPromptHandler 实时反映当前状态", () => {
  // REPL 退出流程会把 handler 置空，所以调用方必须现场问、不能缓存
  const before = hasPromptHandler()
  setQuestionPromptHandler(() => ({}))
  assert.equal(hasPromptHandler(), true)
  setQuestionPromptHandler(null)
  assert.equal(hasPromptHandler(), false)
  assert.equal(before, false)
})

// hasGatePreferences 在本文件里被首个用例的缓存影响，这里只做存在性断言
test("hasGatePreferences 在有记录时为真", async () => {
  await saveGatePreferences({ build: true, test: true, review: true, health: true, budget: true })
  assert.equal(await hasGatePreferences(), true)
})
