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
    // 0.7.4 起选中的模型也写进 models —— 它同样是用户在确认页上看过的字段，
    // 不违反「只写用户确认过的」。选一个时数组就只有一个元素。
    assert.deepEqual(provider.models, ["gateway-b"])
    // 只写用户给的：这些一个都不该出现
    assert.equal(saved.provider.model_context, undefined, "发现结果没带上下文就不写 model_context")
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
    assert.deepEqual(saved.provider["offline-box"].models, ["local-model"], "手动输入的那个就是 models 的唯一元素")
    assert.equal(saved.provider.model_context, undefined, "手动输入没有上下文可写")
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

/**
 * 0.7.4 的模型多选。
 *
 * 浮层把多选结果拼成 `"a, b, c"` 交回表单（dialog-router 的 commitQuestionAnswer），
 * 所以下面脚本里的多选答案就写成那个形状 —— 测的是表单收到真实形状后的行为。
 */
const DISCOVERED = [
  { id: "gpt-4o", contextLength: 128000 },
  { id: "gpt-4o-mini", contextLength: 128000 },
  { id: "o3-mini" },                              // 上下文没发现到
  { id: "text-embedding-3", contextLength: 8191 } // 不选它
]

test("多选三个模型：全部进 models，再追问哪个作默认", async () => {
  await withTempHome(async (home) => {
    const asked = []
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai",
        name: "multi",
        base_url: "https://x.example/v1",
        api_key: "sk-x",
        model: "gpt-4o, o3-mini, gpt-4o-mini",
        default_model: "o3-mini",
        confirm: "save"
      }, asked),
      discover: async () => ({ models: DISCOVERED })
    })

    assert.equal(result.saved, true)
    const provider = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8")).provider.multi
    assert.deepEqual(provider.models, ["gpt-4o", "o3-mini", "gpt-4o-mini"], "选中的三个都要写进配置")
    assert.equal(provider.default_model, "o3-mini", "默认是用户点的那个，不是列表里的第一个")

    const defaultRound = asked.flat().find((q) => q.id === "default_model")
    assert.ok(defaultRound, "选了多个就必须追问默认模型")
    assert.deepEqual(defaultRound.options.map((o) => o.value), ["gpt-4o", "o3-mini", "gpt-4o-mini"],
      "追问的候选就是刚选中的那几个")
    assert.equal(defaultRound.multi, undefined, "选默认是单选")

    const modelRound = asked.flat().find((q) => q.id === "model" && q.options)
    assert.equal(modelRound.multi, true, "模型那轮必须是多选题，否则浮层只让选一个")
  })
})

test("恰好选一个：不追问默认，行为与 0.7.3 一致", async () => {
  await withTempHome(async (home) => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "single", base_url: "https://x.example/v1",
        api_key: "", model: "gpt-4o", confirm: "save"
      }, asked),
      discover: async () => ({ models: DISCOVERED })
    })

    const provider = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8")).provider.single
    assert.deepEqual(provider.models, ["gpt-4o"])
    assert.equal(provider.default_model, "gpt-4o")
    assert.equal(asked.flat().some((q) => q.id === "default_model"), false,
      "只选了一个还追问一遍是多余的一步")
  })
})

test("上下文：发现到的写进 model_context，没发现到的不写、也不编一个", async () => {
  await withTempHome(async (home) => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "ctx", base_url: "https://x.example/v1",
        api_key: "sk-x", model: "gpt-4o, o3-mini", default_model: "gpt-4o", confirm: "save"
      }, asked),
      discover: async () => ({ models: DISCOVERED })
    })

    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider.model_context["gpt-4o"], 128000)
    assert.equal("o3-mini" in saved.provider.model_context, false,
      "上下文发现不到就别写 —— 编一个数字会让压缩阈值静默算错")
    assert.equal("gpt-4o-mini" in saved.provider.model_context, false, "没选中的模型不写")
    assert.equal(saved.provider.ctx.model_context, undefined, "model_context 是 provider 段下的顶层 map")

    const modelRound = asked.flat().find((q) => q.id === "model" && q.options)
    assert.equal(modelRound.options.find((o) => o.value === "gpt-4o").label, "gpt-4o (128k)",
      "挑模型时要能直接看见上下文，这正是用户要比的那个数")
    assert.equal(modelRound.options.find((o) => o.value === "o3-mini").label, "o3-mini (—)")

    const confirmQ = asked.flat().find((q) => q.id === "confirm")
    assert.match(confirmQ.text, /- gpt-4o \(128k\)/, "确认页要逐个列出模型与上下文")
    assert.match(confirmQ.text, /- o3-mini \(—\)/, "没发现到上下文的显示破折号，用户按保存前就该看见")
    assert.match(confirmQ.text, /provider\.model_context:\n {2}gpt-4o: 128000/,
      "所见即所写：model_context 这一段也要出现在预览里")
  })
})

test("多选后不选默认（非交互的空答案）就取消，不悄悄拿第一个", async () => {
  await withTempHome(async (home) => {
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "nodefault", base_url: "https://x.example/v1",
        api_key: "sk-x", model: "gpt-4o, o3-mini", default_model: "", confirm: "save"
      }),
      discover: async () => ({ models: DISCOVERED })
    })
    assert.equal(result.saved, false)
    assert.equal(result.reason, "cancelled")
    await assert.rejects(readFile(path.join(home, "config.yaml"), "utf8"), undefined, "没定默认就不该落盘")
  })
})

test("手动项与真模型一起选中时以真模型为准", async () => {
  await withTempHome(async (home) => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        vendor: "custom-openai", name: "mixed", base_url: "https://x.example/v1",
        api_key: "sk-x", model: "gpt-4o, (manual input)", confirm: "save"
      }, asked),
      discover: async () => ({ models: DISCOVERED })
    })
    const provider = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8")).provider.mixed
    assert.deepEqual(provider.models, ["gpt-4o"], "手动项不是模型 ID，不该混进 models")
    assert.equal(asked.flat().filter((q) => q.id === "model").length, 1, "列表里已经选出东西了，不再问手动输入")
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
