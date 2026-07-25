import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { mergeConfigObject, FORBIDDEN_MERGE_KEYS } from "../src/config/merge.mjs"
import { loadConfig } from "../src/config/load-config.mjs"

/**
 * 0.5.7：项目级配置与主题文件来自用户打开的任意仓库。YAML/JSON 解析会把
 * `__proto__:` 变成自有可枚举属性，深度合并的 `out[key] = ...` 于是命中
 * 原型 setter —— 合并结果的原型被换成攻击者提供的对象。
 *
 * 这条最阴的地方：被注入的键不在自有属性上，JSON.stringify 看不见，
 * 排查配置时完全没有痕迹。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-mergesafe-home-"))
const originalHome = process.env.KKCODE_HOME
process.env.KKCODE_HOME = tmpHome

test.after(async () => {
  if (originalHome === undefined) delete process.env.KKCODE_HOME
  else process.env.KKCODE_HOME = originalHome
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

describe("mergeConfigObject 拒绝危险键", () => {
  it("解析出来的 __proto__ 不会改变合并结果的原型", () => {
    const hostile = YAML.parse("__proto__:\n  injected: true\nmodels:\n  main: m\n")
    assert.ok(Object.keys(hostile).includes("__proto__"), "前提：YAML 确实产生自有属性")

    const merged = mergeConfigObject({ models: {} }, hostile)
    assert.equal(Object.getPrototypeOf(merged), Object.prototype, "原型必须原封不动")
    assert.equal(merged.injected, undefined, "不该有经原型可见的注入值")
    assert.equal(merged.models.main, "m", "同文件里正常的键照常合并")
  })

  it("constructor / prototype 同样被跳过", () => {
    const merged = mergeConfigObject({}, JSON.parse('{"constructor":{"x":1},"prototype":{"y":2},"ok":3}'))
    assert.equal(merged.ok, 3)
    assert.equal(typeof merged.constructor, "function", "constructor 仍是原生的那个")
    assert.equal(merged.prototype, undefined)
  })

  it("全局 Object.prototype 始终干净", () => {
    mergeConfigObject({}, JSON.parse('{"__proto__":{"globallyPolluted":true}}'))
    assert.equal({}.globallyPolluted, undefined)
  })

  it("危险键清单与 config set 的守卫同源", () => {
    assert.deepEqual([...FORBIDDEN_MERGE_KEYS].sort(), ["__proto__", "constructor", "prototype"])
  })
})

describe("端到端：别人仓库里的配置文件不能注入", () => {
  it("项目配置的 __proto__ 段被丢弃，其余键照常生效", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-mergesafe-proj-"))
    try {
      await mkdir(path.join(dir, ".kkcode"), { recursive: true })
      await writeFile(
        path.join(dir, ".kkcode", "config.yaml"),
        "__proto__:\n  totally_new_key:\n    injected: true\nmodels:\n  main: from-project\n",
        "utf8"
      )
      const state = await loadConfig(dir)

      assert.equal(Object.getPrototypeOf(state.config), Object.prototype)
      assert.equal(state.config.totally_new_key, undefined, "默认配置里没有的键不该凭空出现")
      assert.equal(state.config.models.main, "from-project", "合法配置不受影响")
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
