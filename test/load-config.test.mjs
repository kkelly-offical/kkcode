import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"
import os from "node:os"
import { loadConfig } from "../src/config/load-config.mjs"
import { validateConfig } from "../src/config/schema.mjs"
import { applyWorkspaceTrustPolicy } from "../src/context.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cfg-test-"))
  process.env.KKCODE_HOME = tmpDir
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

describe("loadConfig", () => {
  it("returns default config when no files exist", async () => {
    const result = await loadConfig(tmpDir)
    assert.ok(result.config)
    assert.ok(result.config.provider)
    assert.ok(result.config.agent)
    assert.deepEqual(result.errors, [])
  })

  it("loads project YAML config", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  default: openai
`)
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.default, "openai")
    assert.ok(result.source.projectPath)
  })

  it("loads project JSON config", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      provider: { default: "anthropic" }
    }))
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.default, "anthropic")
  })

  it("reports errors for invalid YAML", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), "{{invalid yaml")
    const result = await loadConfig(tmpDir)
    assert.ok(result.errors.length > 0)
  })

  it("merges project config over defaults", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
agent:
  max_steps: 99
`)
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.agent.max_steps, 99)
    // Other defaults should still be present
    assert.ok(result.config.provider)
  })

  it("source includes paths and raw config", async () => {
    const result = await loadConfig(tmpDir)
    assert.equal(result.source.projectPath, null)
    assert.equal(result.source.userPath, null)
  })

  it("normalizes agent.ultra onto the internal agent.longagent key", async () => {
    await writeFile(
      path.join(tmpDir, "config.yaml"),
      "agent:\n  ultra:\n    max_iterations: 42\n    hybrid:\n      intake: false\n",
      "utf8"
    )
    const { config } = await loadConfig(tmpDir)
    assert.equal(config.agent.longagent.max_iterations, 42)
    assert.equal(config.agent.longagent.hybrid.intake, false)
    // defaults from the untouched subtree survive the merge
    assert.equal(typeof config.agent.longagent.heartbeat_timeout_ms, "number")
    assert.equal(config.agent.ultra, undefined)
  })
})

// ---------------------------------------------------------------------------
// 局部失效而非整份丢弃。旧行为：schema 校验一旦失败，整份配置文件被丢成 {}，
// 一个字段写错会让同文件所有合法配置静默失效。修复后：裁掉出错的键并复验，
// 其余配置继续生效，错误照常上报并注明「该项已忽略」。
// ---------------------------------------------------------------------------
describe("loadConfig partial invalidation", () => {
  it("keeps valid keys when one key fails validation", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  default: openai
agent:
  longagent:
    hybrid:
      adaptive_models: "not-an-object"
`)
    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.default, "openai", "合法键必须继续生效")
    assert.equal(result.errors.length, 0, "只忽略单键时不应谎报整份配置失效")
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /adaptive_models/)
    assert.match(result.warnings[0], /该项已忽略/)
    assert.equal(result.source.projectRaw.agent.longagent.hybrid.adaptive_models, undefined,
      "source.projectRaw 表示实际应用的层，不能留下被忽略的脏值")
    assert.equal(result.config.agent.longagent.hybrid.adaptive_models, undefined,
      "被忽略的键不能混入最终运行配置")
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("fails the whole permission layer when a rule is invalid", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
permission:
  level: readonly
  rules:
    - tool: bash
      action: typo
`)

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.permission.level, "manual")
    assert.deepEqual(result.source.projectRaw, {},
      "裁掉 deny/ask rule 可能放宽权限，因此 permission 任一错误都必须整层拒绝")
    assert.ok(result.errors.some((error) => /permission\.rules\[0\]\.action/.test(error)))
    assert.equal(result.warnings.length, 0)
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("reports multiple invalid permission rules without applying a partial policy", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
permission:
  level: readonly
  rules:
    - tool: bash
      action: typo-a
    - tool: read
      action: allow
    - tool: write
      action: typo-b
`)

    const result = await loadConfig(tmpDir)
    assert.deepEqual(result.source.projectRaw, {})
    assert.equal(result.config.permission.level, "manual")
    assert.ok(result.errors.some((error) => error.includes("rules[0]")))
    assert.ok(result.errors.some((error) => error.includes("rules[2]")))
    assert.equal(result.warnings.length, 0)
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("keeps permission and sandbox contract violations as hard config errors", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })

    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  default: openai
permission:
  level: full-auto
`)
    const badLevel = await loadConfig(tmpDir)
    assert.ok(badLevel.errors.some((error) => error.includes("permission.level")))
    assert.equal(badLevel.warnings.length, 0,
      "权限档写错不能静默裁剪后继续启动")
    assert.deepEqual(badLevel.source.projectRaw, {}, "安全契约错误应丢弃整个配置层")

    await writeFile(path.join(kkDir, "config.yaml"), `
permission:
  sandbox:
    mode: typo
`)
    const badSandbox = await loadConfig(tmpDir)
    assert.ok(badSandbox.errors.some((error) => error.includes("permission.sandbox.mode")))
    assert.equal(badSandbox.warnings.length, 0,
      "用户以为沙箱已开启时，不能只给一个容易漏看的普通 warning")
    assert.deepEqual(badSandbox.source.projectRaw, {})
  })

  it("normalizes agent.ultra before validation and removes an invalid aliased value", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
agent:
  ultra:
    max_iterations: not-a-number
provider:
  default: openai
`)

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.default, "openai")
    assert.equal(result.config.agent.longagent.max_iterations, 0,
      "无效 alias 值被裁掉后应回落到已验证的默认值")
    assert.equal(result.source.projectRaw.agent.longagent.max_iterations, undefined)
    assert.match(result.warnings[0], /agent\.longagent\.max_iterations/)
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("falls back to the same layer's canonical value when a higher-priority alias is invalid", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })

    for (const badAlias of [null, false, "bad"]) {
      await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
        agent: {
          longagent: { max_iterations: 5 },
          ultra: badAlias === "bad" ? { max_iterations: badAlias } : badAlias
        }
      }))
      const result = await loadConfig(tmpDir)
      assert.equal(result.config.agent.longagent.max_iterations, 5,
        `invalid alias ${JSON.stringify(badAlias)} must not erase canonical fallback`)
      assert.equal(result.source.projectRaw.agent.longagent.max_iterations, 5)
      assert.ok(result.warnings.some((warning) => warning.includes("agent.longagent")))
    }
  })

  it("applies valid alias siblings while invalid alias fields fall back to canonical", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      agent: {
        longagent: { max_iterations: 5, heartbeat_timeout_ms: 3000 },
        ultra: { max_iterations: "bad", heartbeat_timeout_ms: 9000 }
      }
    }))

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.agent.longagent.max_iterations, 5)
    assert.equal(result.config.agent.longagent.heartbeat_timeout_ms, 9000)
    assert.equal(result.source.projectRaw.agent.ultra, undefined)
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("validates a non-object nested ultra before hoisting flat goal keys", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      agent: { ultra: { goal_mode: true, ultra: "bad" } }
    }))

    const result = await loadConfig(tmpDir)
    assert.ok(result.warnings.some((warning) => warning.includes("agent.longagent.ultra")))
    assert.equal(result.config.agent.longagent.ultra.goal_mode, true,
      "nested bad value is pruned first, then the valid flat compatibility key is hoisted")
    assert.equal(Object.hasOwn(result.config.agent.longagent.ultra, "0"), false,
      "a string must never be spread into numeric config keys")
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("rejects the entire physical layer when permission errors coexist with an ultra alias", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      permission: { level: "typo" },
      agent: { ultra: { max_iterations: 9 } }
    }))

    const result = await loadConfig(tmpDir)
    assert.deepEqual(result.source.projectRaw, {})
    assert.equal(result.config.agent.longagent.max_iterations, 0)
    assert.ok(result.errors.some((error) => error.includes("permission.level")))
  })

  it("validates and prunes an invalid .env overlay instead of bypassing schema", async () => {
    await writeFile(path.join(tmpDir, ".env"), "KKCODE_AGENT__MAX_STEPS=bad\nKKCODE_LANGUAGE=zh\n")

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.agent.max_steps, 8, "坏的 env 值必须回落到已验证的低优先级值")
    assert.equal(result.config.language, "zh", "同一 env 里的合法键应继续生效")
    assert.equal(result.source.envOverlay.agent?.max_steps, undefined)
    assert.match(result.warnings[0], /agent\.max_steps/)
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("falls back to a validated user value when the project overrides it incorrectly", async () => {
    const userDir = path.join(tmpDir, "user-home")
    process.env.KKCODE_HOME = userDir
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, "config.yaml"), "agent:\n  max_steps: 23\n")
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), "agent:\n  max_steps: wrong\nlanguage: zh\n")

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.agent.max_steps, 23, "裁掉项目坏值后必须露出用户层，而非 defaults")
    assert.equal(result.config.language, "zh")
    assert.equal(result.source.projectRaw.agent.max_steps, undefined)
  })

  it("revalidates repeatedly when pruning one key exposes another invalid dependency", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  default: broken
  broken: not-an-object
language: zh
`)

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.language, "zh")
    assert.equal(result.source.projectRaw.provider.broken, undefined)
    assert.equal(result.source.projectRaw.provider.default, undefined)
    assert.ok(result.warnings.some((warning) => warning.includes("provider.broken")))
    assert.ok(result.warnings.some((warning) => warning.includes("provider.default")))
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("does not let merge inheritance hide an invalid non-permission null", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      agent: { max_steps: null },
      language: "zh"
    }))

    const result = await loadConfig(tmpDir)
    assert.equal(result.errors.length, 0)
    assert.ok(result.warnings.some((warning) => warning.includes("agent.max_steps")),
      "mergeConfigObject 的 null=inherit 语义不能遮住普通字段校验")
    assert.equal(result.config.agent.max_steps, 8)
    assert.equal(result.config.language, "zh")
  })

  it("does not let alias normalization hide an invalid null", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      agent: { ultra: { max_iterations: null } },
      language: "zh"
    }))

    const result = await loadConfig(tmpDir)
    assert.ok(result.warnings.some((warning) => warning.includes("agent.longagent.max_iterations")))
    assert.equal(result.config.agent.longagent.max_iterations, 0)
    assert.equal(result.config.language, "zh")
  })

  it("normalizes every present agent.ultra alias even when its value is falsy", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    for (const value of [false, 0, "", null]) {
      await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
        agent: { ultra: value },
        language: "zh"
      }))
      const result = await loadConfig(tmpDir)
      assert.ok(result.warnings.some((warning) => warning.includes("agent.longagent")),
        `agent.ultra=${JSON.stringify(value)} 不得绕过 schema`)
      assert.equal(result.config.language, "zh")
      assert.equal(result.source.projectRaw.agent?.ultra, undefined)
      assert.equal(validateConfig(result.config).valid, true)
    }
  })

  it("keeps permission null as a hard layer error", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.json"), JSON.stringify({
      permission: { level: null },
      language: "zh"
    }))

    const result = await loadConfig(tmpDir)
    assert.ok(result.errors.some((error) => error.includes("permission.level")))
    assert.equal(result.warnings.length, 0)
    assert.deepEqual(result.source.projectRaw, {})
  })

  it("validates a user-scoped .env against user config without borrowing project keys", async () => {
    const userDir = path.join(tmpDir, "user-env-home")
    process.env.KKCODE_HOME = userDir
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, ".env"), "KKCODE_PROVIDER__DEFAULT=project-only\n")

    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  project-only:
    type: openai-compatible
    base_url: http://127.0.0.1:9999/v1
`)

    const result = await loadConfig(tmpDir)
    assert.equal(result.source.envScope, "user")
    assert.equal(result.userConfig.provider.default, undefined,
      "不受信任工作区使用的 userConfig 必须能脱离项目独立成立")
    assert.equal(validateConfig(result.userConfig).valid, true)
    assert.ok(result.warnings.some((warning) => warning.includes("provider.default")))
  })

  it("rejects only a user .env override that conflicts with the project layer", async () => {
    const userDir = path.join(tmpDir, "user-env-conflict")
    process.env.KKCODE_HOME = userDir
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, "config.yaml"), `
provider:
  custom:
    type: gateway
    protocol: openai
    base_url: https://user.example/v1
language: zh
`)
    await writeFile(path.join(userDir, ".env"), "KKCODE_PROVIDER__CUSTOM__TYPE=gateway\n")

    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  custom:
    type: openai-compatible
    base_url: ""
`)

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.language, "zh", "冲突 env 不能把合法 user/project 全清成 defaults")
    assert.equal(result.config.provider.custom.type, "openai-compatible")
    assert.equal(result.config.provider.custom.base_url, "")
    assert.equal(result.source.envOverlay.provider?.custom?.type, undefined)
    assert.ok(result.warnings.some((warning) => warning.includes("provider.custom")))
    assert.equal(result.errors.length, 0)
    assert.equal(validateConfig(result.config).valid, true)
  })

  it("keeps an independently valid user .env value in untrusted-workspace config when project composition conflicts", async () => {
    const userDir = path.join(tmpDir, "user-env-untrusted")
    process.env.KKCODE_HOME = userDir
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, "config.yaml"), `
provider:
  custom:
    type: openai-compatible
    protocol: anthropic
    base_url: https://user.example/v1
`)
    await writeFile(path.join(userDir, ".env"), "KKCODE_PROVIDER__CUSTOM__TYPE=gateway\n")

    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  custom:
    type: openai-compatible
    base_url: ""
`)

    const result = await loadConfig(tmpDir)
    assert.equal(result.config.provider.custom.type, "openai-compatible",
      "trusted project view must prune the env field that makes the composed provider invalid")
    assert.equal(result.source.envOverlay.provider?.custom?.type, undefined)
    assert.ok(result.warnings.some((warning) => warning.includes("provider.custom")))

    assert.equal(result.userConfig.provider.custom.type, "gateway",
      "project-only conflicts must not erase a user .env value that is valid without the project")
    assert.equal(validateConfig(result.userConfig).valid, true)
    applyWorkspaceTrustPolicy(result, { trusted: false }, tmpDir)
    assert.equal(result.extensionConfig.provider.custom.type, "gateway",
      "an untrusted workspace must receive the independently validated user configuration")
  })

  it("never follows a validation path into Object.prototype", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    await writeFile(path.join(kkDir, "config.yaml"), `
provider:
  model_context:
    "__proto__.toString": 1
`)

    // 放到子进程里做：旧实现会真的 delete Object.prototype.toString，
    // 回归测试即使变红也不能污染当前 node:test 进程。
    const moduleUrl = pathToFileURL(path.resolve("src/config/load-config.mjs")).href
    const script = `
      import { loadConfig } from ${JSON.stringify(moduleUrl)}
      const before = Object.getOwnPropertyDescriptor(Object.prototype, "toString")
      const result = await loadConfig(${JSON.stringify(tmpDir)})
      const after = Object.getOwnPropertyDescriptor(Object.prototype, "toString")
      process.stdout.write(JSON.stringify({
        intact: Boolean(before && after && before.value === after.value),
        errors: result.errors,
        warnings: result.warnings
      }))
    `
    const childHome = path.join(tmpDir, "isolated-home")
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, KKCODE_HOME: childHome }
    })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout)
    assert.equal(result.intact, true, "不可信错误路径绝不能进入全局原型")
    assert.ok(result.errors.length > 0, "无法安全定位的动态键应 fail-safe 丢弃该层")
  })

  it("still discards the whole file when errors cannot be pruned away", async () => {
    const kkDir = path.join(tmpDir, ".kkcode")
    await mkdir(kkDir, { recursive: true })
    // 顶层就不是对象 —— 无键可裁，必须退回整份丢弃
    await writeFile(path.join(kkDir, "config.yaml"), `"just a string"`)
    const result = await loadConfig(tmpDir)
    assert.ok(result.errors.length >= 1)
    assert.ok(!result.errors[0].includes("该项已忽略"))
  })
})
