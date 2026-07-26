import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { validateConfig } from "../src/config/schema.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { normalizePermissionLevel } from "../src/permission/rules.mjs"

/**
 * 0.6.0：0.4.0 弃用期到期，旧权限词汇移除。
 *
 * 这里刻意选择**报错**而不是静默忽略：权限档决定哪些工具不经确认就能跑。
 * 悄悄回落到默认值意味着用户以为自己还锁着、实际可能更松 —— 那是升级里
 * 最不该发生的一类事故。报错会带上对应的新写法，改一行即可。
 */

describe("旧键被拒，并指出替代写法", () => {
  it("permission.mode 报错并指向 permission.level", () => {
    const result = validateConfig({ permission: { mode: "yolo" } })
    assert.equal(result.valid, false)
    assert.match(result.errors.join(";"), /permission\.mode/)
    assert.match(result.errors.join(";"), /permission\.level/)
  })

  it("permission.default_policy 报错并给出三条映射", () => {
    const result = validateConfig({ permission: { default_policy: "allow" } })
    assert.equal(result.valid, false)
    assert.match(result.errors.join(";"), /accept-edits/)
  })

  it("旧等级名逐个报错，且给出确切的新名字", () => {
    const expected = {
      review: "manual",
      auto: "manual",
      edit: "accept-edits",
      "full-auto": "accept-edits"
    }
    for (const [legacy, replacement] of Object.entries(expected)) {
      const result = validateConfig({ permission: { level: legacy } })
      assert.equal(result.valid, false, `${legacy} 应当被拒绝`)
      assert.match(result.errors.join(";"), new RegExp(replacement.replace("-", "\\-")))
    }
  })

  it("四个新档位照常通过", () => {
    for (const level of ["readonly", "manual", "accept-edits", "yolo"]) {
      assert.equal(validateConfig({ permission: { level } }).valid, true, level)
    }
  })

  it("默认配置自证合法（移除不能把自己也拒了）", () => {
    const result = validateConfig(DEFAULT_CONFIG)
    assert.equal(result.valid, true, result.errors.join("; "))
  })
})

describe("运行时对失效旧值只会更保守", () => {
  it("旧名回落到默认档，绝不解析成它当年更宽松的对应档", () => {
    for (const legacy of ["review", "auto", "edit", "full-auto", "nonsense"]) {
      assert.equal(normalizePermissionLevel({ level: legacy }), "manual", legacy)
    }
  })

  it("只写 mode / default_policy 不再产生任何权限", () => {
    assert.equal(normalizePermissionLevel({ mode: "yolo" }), "manual")
    assert.equal(normalizePermissionLevel({ default_policy: "allow" }), "manual")
  })

  it("新档位原样返回", () => {
    assert.equal(normalizePermissionLevel({ level: "yolo" }), "yolo")
    assert.equal(normalizePermissionLevel({ level: "readonly" }), "readonly")
  })
})
