import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import YAML from "yaml"
import { runProviderAddForm } from "../src/provider/wizard-form.mjs"
import { loadProviderModelItems } from "../src/repl.mjs"

/**
 * `/provider add` 表单流程的行为测试（0.7.3 起走 wizard-form，旧的十二步逐行
 * 状态机已删除）。`ask` 是表单唯一的交互出口，注入一个「按题回答」的假实现即可
 * 驱动全流程 —— 不模拟按键、不依赖 TTY，测的是每一轮问了什么、最后写了什么。
 */

/** 逐题回答：按 id 从答案表里取；没写的题用它的 default（等于用户直接回车）。 */
function scriptedAsk(answerBook, transcript = []) {
  return async ({ questions }) => {
    transcript.push(questions)
    const out = {}
    for (const q of questions) {
      out[q.id] = Object.prototype.hasOwnProperty.call(answerBook, q.id)
        ? answerBook[q.id]
        : (q.default ?? "")
    }
    return out
  }
}

async function withTempHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "kkcode-form-"))
  process.env.KKCODE_HOME = home
  try {
    return await run(home)
  } finally {
    delete process.env.KKCODE_HOME
    await rm(home, { recursive: true, force: true })
  }
}

test("custom gateway end to end: discovery sees the draft, only chosen fields are saved", async () => {
  await withTempHome(async (home) => {
    let discoveredConfig = null
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-gateway",
        protocol: "openai",
        name: "company-gateway",
        base_url: "https://gateway.example/v1",
        api_key: "sk-secret-1234",
        context_limit: "",
        model: "gateway-b",
        confirm: "save"
      }),
      discover: async (configState) => {
        discoveredConfig = configState.config
        return { models: [{ id: "gateway-a" }, { id: "gateway-b" }] }
      }
    })

    assert.equal(result.saved, true)
    assert.equal(result.name, "company-gateway")
    // 发现用的 draft 里已带用户刚输入的 key —— 它能连上私有网关正是因为这个
    assert.equal(discoveredConfig.provider["company-gateway"].api_key, "sk-secret-1234")
    assert.equal(discoveredConfig.provider["company-gateway"].type, "gateway")

    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    const provider = saved.provider["company-gateway"]
    assert.equal(provider.type, "gateway")
    assert.equal(provider.protocol, "openai")
    assert.equal(provider.base_url, "https://gateway.example/v1")
    assert.equal(provider.api_key, "sk-secret-1234", "用户输入的密钥明文写入 —— 0.7.3 的显式要求")
    assert.equal(provider.default_model, "gateway-b")
    // 只写用户给的：这些一个都不该出现
    assert.equal(provider.models, undefined)
    assert.equal(provider.context_limit, undefined, "留空的 context_limit 不写")
    assert.equal(provider.thinking, undefined, "没答过的 thinking 不写")
    assert.equal(provider.api_key_env, undefined, "填了明文 key 就不再写环境变量名")
    assert.equal(saved.provider.default, "company-gateway")
  })
})

test("the config file lands with 0600 once a key can be inside", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX 权限位"); return }
  await withTempHome(async (home) => {
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "p", base_url: "https://x.example/v1",
        api_key: "sk-abc", model: "m1", confirm: "save"
      }),
      discover: async () => ({ models: [] })
    })
    const mode = (await stat(path.join(home, "config.yaml"))).mode & 0o777
    assert.equal(mode, 0o600, `明文密钥的配置文件必须是 0600，实际 ${mode.toString(8)}`)
  })
})

test("discovery failure degrades to manual model input, not an error", async () => {
  await withTempHome(async (home) => {
    const asked = []
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai",
        name: "offline-box",
        base_url: "https://box.local/v1",
        api_key: "",
        model: "local-model",
        confirm: "save"
      }, asked),
      discover: async () => { throw new Error("network down") }
    })
    assert.equal(result.saved, true)
    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider["offline-box"].default_model, "local-model")
    assert.equal(saved.provider["offline-box"].api_key, undefined, "留空的 key 不写")
    // 发现失败时不该出现「从列表里选」那一轮 —— 只有手动输入
    const modelRounds = asked.filter((qs) => qs.some((q) => q.id === "model"))
    assert.equal(modelRounds.length, 1, "只该有手动输入这一轮")
    assert.equal(modelRounds[0].find((q) => q.id === "model").options, undefined)
  })
})

test("cancelling at the confirm page writes nothing", async () => {
  await withTempHome(async (home) => {
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "nope", base_url: "https://x.example/v1",
        api_key: "sk-x", model: "m", confirm: "cancel"
      }),
      discover: async () => ({ models: [] })
    })
    assert.equal(result.saved, false)
    await assert.rejects(readFile(path.join(home, "config.yaml"), "utf8"), undefined, "取消后不该有配置文件")
  })
})

test("non-interactive empty answers cancel at the first round", async () => {
  // askQuestionInteractive 在非 TTY 下返回全空 —— 表单必须把它当成取消，
  // 而不是拿空串往下配出一个残废 provider
  await withTempHome(async (home) => {
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: async ({ questions }) => Object.fromEntries(questions.map((q) => [q.id, ""])),
      discover: async () => ({ models: [] })
    })
    assert.equal(result.saved, false)
    assert.equal(result.reason, "cancelled")
    await assert.rejects(readFile(path.join(home, "config.yaml"), "utf8"))
  })
})

test("the api key question is marked secret and the preview only shows the tail", async () => {
  // 遮蔽是渲染层与确认页两处的契约：表单必须把 secret 标出来，预览不给全文
  await withTempHome(async () => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "p", base_url: "https://x.example/v1",
        api_key: "sk-verylongsecret-tail9999", model: "m1", confirm: "save"
      }, asked),
      discover: async () => ({ models: [] })
    })
    const keyQ = asked.flat().find((q) => q.id === "api_key")
    assert.equal(keyQ.secret, true, "密钥题必须带 secret 标记，浮层据此遮蔽")
    const confirmQ = asked.flat().find((q) => q.id === "confirm")
    assert.doesNotMatch(confirmQ.text, /sk-verylongsecret/, "确认页不得出现密钥全文")
    assert.match(confirmQ.text, /9999/, "末四位要显示，让用户能核对贴对了没有")
    assert.match(confirmQ.text, /明文保存/, "明文落盘这件事要在确认页说出来")
  })
})

test("REPL model items use only the requested dynamic provider catalog", async () => {
  const calls = []
  const configState = {
    config: {
      provider: {
        default: "one",
        one: { models: ["hardcoded-must-not-be-used"] },
        two: { models: ["other-provider"] }
      }
    },
    source: { userRaw: {}, projectRaw: {}, envOverlay: {} }
  }
  const result = await loadProviderModelItems(configState, "one", {
    refresh: true,
    discover: async (_state, options) => {
      calls.push(options)
      return {
        models: [{ id: "live-a" }, { id: "live-a" }, { id: "live-b" }],
        source: "network",
        stale: false
      }
    }
  })
  assert.deepEqual(result.items.map((item) => item.model), ["live-a", "live-b"])
  assert.equal(calls[0].providerName, "one")
  assert.equal(calls[0].refresh, true)
})

test("REPL model items do not fall back to effective hardcoded arrays on discovery failure", async () => {
  const result = await loadProviderModelItems({
    config: {
      provider: {
        default: "openai",
        openai: { models: ["system-default"] }
      }
    },
    source: { userRaw: {}, projectRaw: {}, envOverlay: {} }
  }, "openai", {
    discover: async () => {
      throw new Error("offline")
    }
  })
  assert.deepEqual(result.items, [])
  assert.equal(result.error, "offline")
})
