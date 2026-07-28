import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import YAML from "yaml"
import { runProviderAddForm, suggestProviderName } from "../src/provider/wizard-form.mjs"
import { loadProviderModelItems } from "../src/repl.mjs"
import { modelThinkingSupport } from "../src/repl/provider-catalog.mjs"

/**
 * `/provider add` 表单流程的行为测试（0.8.0 起去模板化：接口形式 → URL/Key →
 * 自动发现 → 只补问读不到的）。`ask` 是表单唯一的交互出口，注入一个「按题回答」
 * 的假实现即可驱动全流程 —— 不模拟按键、不依赖 TTY，测的是每一轮问了什么、
 * 最后写了什么。
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

test("名称从 URL host 推导：厂商名可提取，generic 前缀与 TLD 尾巴都不算名字", () => {
  assert.equal(suggestProviderName("https://api.moonshot.ai/v1"), "moonshot")
  assert.equal(suggestProviderName("http://llm-api.ecupl.edu.cn/v1"), "ecupl")
  assert.equal(suggestProviderName("https://open.bigmodel.cn/api/paas/v4"), "bigmodel")
  assert.equal(suggestProviderName("https://api.openai.com/v1"), "openai")
  assert.equal(suggestProviderName("https://coding.dashscope.aliyuncs.com/v1"), "dashscope")
  assert.equal(suggestProviderName("http://localhost:11434"), "local", "localhost 没有语义")
  assert.equal(suggestProviderName("http://192.168.1.5:8000/v1"), "local", "IP 没有语义")
  assert.equal(suggestProviderName("not a url"), "", "解析不了就空着，调用方兜底")
})

test("openai 形式端到端：三样输入起步，发现看得到 draft，只写用户确认过的字段", async () => {
  await withTempHome(async (home) => {
    let discoveredConfig = null
    let discoverOptions = null
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai",
        base_url: "https://api.acme.com/v1",
        api_key: "sk-secret-1234",
        model: "acme-b",
        confirm: "save"
      }),
      discover: async (configState, options) => {
        discoveredConfig = configState.config
        discoverOptions = options
        return { models: [{ id: "acme-a" }, { id: "acme-b" }] }
      }
    })

    assert.equal(result.saved, true)
    assert.equal(result.name, "acme", "名称从 URL host 自动推导，不再问一轮")
    // 发现用的 draft 里已带用户刚输入的 key —— 它能连上私有服务正是因为这个
    assert.equal(discoveredConfig.provider.acme.api_key, "sk-secret-1234")
    assert.equal(discoveredConfig.provider.acme.type, "openai-compatible")
    // 0.8.0 修的真缺陷：此前 name 被当成 options 传，refresh: true 整个丢失，
    // 表单的模型发现一直吃 15 分钟缓存 —— 刚填的新密钥换不来新目录
    assert.equal(discoverOptions.refresh, true)
    assert.equal(discoverOptions.providerName, "acme")

    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    const provider = saved.provider.acme
    assert.equal(provider.type, "openai-compatible", "接口形式直接决定 type，没有模板中介")
    assert.equal(provider.base_url, "https://api.acme.com/v1")
    assert.equal(provider.api_key, "sk-secret-1234", "用户输入的密钥明文写入 —— 0.7.3 的显式要求")
    assert.equal(provider.default_model, "acme-b")
    assert.deepEqual(provider.models, ["acme-b"])
    // 只写用户给的：这些一个都不该出现
    assert.equal(saved.provider.model_context, undefined, "发现结果没带上下文就不写 model_context")
    assert.equal(provider.context_limit, undefined)
    assert.equal(provider.thinking, undefined)
    assert.equal(provider.api_key_env, undefined, "没有模板，也就没有环境变量名可以静默写入")
    assert.equal(saved.provider.default, "acme")
  })
})

test("anthropic 形式写 type: anthropic", async () => {
  await withTempHome(async (home) => {
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "anthropic",
        base_url: "https://claude-gw.corp.example/v1",
        api_key: "sk-ant-x",
        model: "claude-sonnet-4-6",
        confirm: "save"
      }),
      discover: async () => ({ models: [] })
    })
    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    const name = saved.provider.default
    assert.equal(saved.provider[name].type, "anthropic")
  })
})

test("the config file lands with 0600 once a key can be inside", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX 权限位"); return }
  await withTempHome(async (home) => {
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://x.example/v1",
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
        protocol: "openai",
        base_url: "https://box.internal/v1",
        api_key: "",
        model: "local-model",
        confirm: "save"
      }, asked),
      discover: async () => { throw new Error("network down") }
    })
    assert.equal(result.saved, true)
    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider[result.name].default_model, "local-model")
    assert.deepEqual(saved.provider[result.name].models, ["local-model"], "手动输入的那个就是 models 的唯一元素")
    assert.equal(saved.provider.model_context, undefined, "手动输入没有上下文可写、用户也没补")
    assert.equal(saved.provider[result.name].api_key, undefined, "留空的 key 不写")
    // 发现失败时不该出现「从列表里选」那一轮 —— 只有手动输入
    const modelRounds = asked.filter((qs) => qs.some((q) => q.id === "model"))
    assert.equal(modelRounds.length, 1, "只该有手动输入这一轮")
    assert.equal(modelRounds[0].find((q) => q.id === "model").options, undefined)
    // 上下文读不到 → 追问了一轮（留空 = 不写）；thinking 认不出 → 也追问了
    assert.ok(asked.flat().some((q) => q.id === "ctx:local-model"), "读不到的上下文要给用户补的机会")
    assert.ok(asked.flat().some((q) => q.id === "think:local-model"), "认不出的 thinking 要给用户补的机会")
  })
})

test("cancelling at the confirm page writes nothing", async () => {
  await withTempHome(async (home) => {
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://x.example/v1",
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
        protocol: "openai", base_url: "https://x.example/v1",
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

test("确认页可以改名，改完回到确认页再保存", async () => {
  await withTempHome(async (home) => {
    // confirm 会被问两次（rename 前后），静态答案表做不到 —— 用一个按次序出答案的 ask
    const confirmAnswers = ["rename", "save"]
    const ask = async ({ questions }) => {
      const out = {}
      for (const q of questions) {
        if (q.id === "protocol") out[q.id] = "openai"
        else if (q.id === "base_url") out[q.id] = "https://api.acme.com/v1"
        else if (q.id === "api_key") out[q.id] = "sk-x"
        else if (q.id === "model") out[q.id] = "m1"
        else if (q.id === "confirm") out[q.id] = confirmAnswers.shift()
        else if (q.id === "name") out[q.id] = "My Company GW"
        else out[q.id] = q.default ?? ""
      }
      return out
    }
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask,
      discover: async () => ({ models: [] })
    })
    assert.equal(result.saved, true)
    assert.equal(result.name, "my_company_gw", "改名走同一套 sanitize，落盘键名合法")
    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.ok(saved.provider.my_company_gw)
    assert.equal(saved.provider.acme, undefined, "推导名没被用上就不该出现")
    assert.equal(saved.provider.default, "my_company_gw")
  })
})

/**
 * 模型多选。浮层把多选结果拼成 `"a, b, c"` 交回表单（dialog-router 的
 * commitQuestionAnswer），所以下面脚本里的多选答案就写成那个形状。
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
        protocol: "openai",
        base_url: "https://api.multi.ai/v1",
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
    // 0.8.0：不再 slice(0, 30) —— 发现到几个就列几个（浮层有滚动与过滤）
    assert.equal(modelRound.options.length, DISCOVERED.length + 1, "全量列出 + 手动项")
  })
})

test("恰好选一个：不追问默认", async () => {
  await withTempHome(async (home) => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://api.single.ai/v1",
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

test("上下文：发现到的写进 model_context；没发现到的追问，留空仍然不写、不编数字", async () => {
  await withTempHome(async (home) => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://api.ctx.ai/v1",
        api_key: "sk-x", model: "gpt-4o, o3-mini", default_model: "gpt-4o", confirm: "save"
      }, asked),
      discover: async () => ({ models: DISCOVERED })
    })

    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider.model_context["gpt-4o"], 128000)
    assert.equal("o3-mini" in saved.provider.model_context, false,
      "追问留空就不写 —— 编一个数字会让压缩阈值静默算错")
    assert.equal("gpt-4o-mini" in saved.provider.model_context, false, "没选中的模型不写")
    assert.equal(saved.provider.ctx.model_context, undefined, "model_context 是 provider 段下的顶层 map")

    // 「只有缺失信息才要用户动手」：读到了的 gpt-4o 一个字都不问，缺的 o3-mini 问一格
    const ctxRounds = asked.flat().filter((q) => q.id.startsWith("ctx:"))
    assert.deepEqual(ctxRounds.map((q) => q.id), ["ctx:o3-mini"])

    const modelRound = asked.flat().find((q) => q.id === "model" && q.options)
    assert.equal(modelRound.options.find((o) => o.value === "gpt-4o").label, "gpt-4o (128k)",
      "挑模型时要能直接看见上下文，这正是用户要比的那个数")
    assert.equal(modelRound.options.find((o) => o.value === "o3-mini").label, "o3-mini (—)")

    const confirmQ = asked.flat().find((q) => q.id === "confirm")
    assert.match(confirmQ.text, /- gpt-4o \(128k\)/, "确认页要逐个列出模型与上下文")
    assert.match(confirmQ.text, /provider\.model_context:\n {2}gpt-4o: 128000/,
      "所见即所写：model_context 这一段也要出现在预览里")
  })
})

test("追问的上下文答了就写进 model_context", async () => {
  await withTempHome(async (home) => {
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://api.ctxfill.ai/v1",
        api_key: "sk-x", model: "o3-mini", "ctx:o3-mini": "200000", confirm: "save"
      }),
      discover: async () => ({ models: DISCOVERED })
    })
    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider.model_context["o3-mini"], 200000, "用户补的数字与发现到的走同一个出口")
  })
})

test("多选后不选默认（非交互的空答案）就取消，不悄悄拿第一个", async () => {
  await withTempHome(async (home) => {
    const result = await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://api.nodefault.ai/v1",
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
        protocol: "openai", base_url: "https://api.mixed.ai/v1",
        api_key: "sk-x", model: "gpt-4o, (manual input)", confirm: "save"
      }, asked),
      discover: async () => ({ models: DISCOVERED })
    })
    const provider = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8")).provider.mixed
    assert.deepEqual(provider.models, ["gpt-4o"], "手动项不是模型 ID，不该混进 models")
    assert.equal(asked.flat().filter((q) => q.id === "model").length, 1, "列表里已经选出东西了，不再问手动输入")
  })
})

// --- thinking 支持的自动检测与补问（0.8.0） ---

test("thinking：目录报了 supported_parameters 就不问；报不出的才问；答案与检测走同一个出口", async () => {
  await withTempHome(async (home) => {
    const asked = []
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://api.think.ai/v1",
        api_key: "sk-x",
        model: "reasoner-x, plain-x, mystery-x",
        default_model: "reasoner-x",
        "think:mystery-x": "yes",
        confirm: "save"
      }, asked),
      // 形状对齐 discoverModelsForProvider 的真实输出：normalizeModels 已把
      // supported_parameters 转成 camelCase —— 夹具不能比现实更慷慨，也不能更旧
      discover: async () => ({
        models: [
          { id: "reasoner-x", contextLength: 128000, supportedParameters: ["reasoning_effort", "temperature"] },
          { id: "plain-x", contextLength: 8192, supportedParameters: ["temperature"] },
          { id: "mystery-x", contextLength: 32768 }
        ]
      })
    })

    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider.model_thinking["reasoner-x"], true, "supported_parameters 报了 reasoning → 自动 true")
    assert.equal(saved.provider.model_thinking["plain-x"], false, "报了参数表但没有 reasoning → 自动 false，false 也有价值")
    assert.equal(saved.provider.model_thinking["mystery-x"], true, "判不出的问用户，用户答了「支持」")

    const thinkRounds = asked.flat().filter((q) => q.id.startsWith("think:"))
    assert.deepEqual(thinkRounds.map((q) => q.id), ["think:mystery-x"],
      "能自动判的（true 和 false 都算判出）一个都不问")

    const confirmQ = asked.flat().find((q) => q.id === "confirm")
    assert.match(confirmQ.text, /provider\.model_thinking:/, "自动检测不是背着用户写配置的许可 —— 确认页要列出来")
  })
})

test("thinking：用户答「不确定」就不写", async () => {
  await withTempHome(async (home) => {
    await runProviderAddForm({
      configState: { config: { provider: {} } },
      ask: scriptedAsk({
        protocol: "openai", base_url: "https://api.unsure.ai/v1",
        api_key: "sk-x", model: "mystery-y", "think:mystery-y": "skip", confirm: "save"
      }),
      discover: async () => ({ models: [{ id: "mystery-y", contextLength: 4096 }] })
    })
    const saved = YAML.parse(await readFile(path.join(home, "config.yaml"), "utf8"))
    assert.equal(saved.provider.model_thinking, undefined, "跳过 = 不写，没有半个条目的 map")
  })
})

// --- /model 的目录管线（与表单无关，保持原有断言） ---

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

test("REPL model items carry context and thinking capability into the picker", async () => {
  // 0.7.x 的缺口：上下文刚被 applyDiscoveredContextLimits 读出来，组装 items
  // 时却丢掉了 —— 用户在 /model 里对着一排裸名字挑，还得自己记哪个是 1m 窗口。
  const result = await loadProviderModelItems({
    config: {
      provider: {
        default: "kimi",
        kimi: {},
        model_context: { "cfg-known": 262144 },
        model_thinking: { "cfg-thinker": true }
      }
    },
    source: { userRaw: {}, projectRaw: {}, envOverlay: {} }
  }, "kimi", {
    discover: async () => ({
      models: [
        { id: "k3", contextLength: 1048576 },
        { id: "cfg-known" },                    // 目录没报，但 model_context 里有
        { id: "cfg-thinker" },                  // thinking 能力来自配置
        { id: "plain", supportedParameters: ["temperature"] }
      ],
      source: "network",
      stale: false
    })
  })
  const byModel = Object.fromEntries(result.items.map((item) => [item.model, item]))
  assert.equal(byModel.k3.contextLength, 1048576)
  assert.match(byModel.k3.label, /\(1m\)/, "上下文要出现在选择器标签里")
  assert.match(byModel.k3.label, /· 思考/, "k3 名族启发式判定支持思考，标签要说出来")
  assert.equal(byModel["cfg-known"].contextLength, 262144, "目录没报时用配置/发现累积的 model_context")
  assert.equal(byModel["cfg-thinker"].thinking, true, "配置的 model_thinking 优先于启发式")
  assert.equal(byModel.plain.thinking, false, "supported_parameters 没有 reasoning → false")
  assert.doesNotMatch(byModel.plain.label, /思考/)
})

test("modelThinkingSupport: 配置结论 > 目录参数表 > 名字启发式", () => {
  const config = { provider: { model_thinking: { "x-model": false } } }
  // 配置说 false，即使参数表说支持也以配置为准 —— 用户补答过的结论不该被猜测覆盖
  assert.equal(modelThinkingSupport({ config, model: "x-model", supportedParameters: ["reasoning"] }), false)
  assert.equal(modelThinkingSupport({ config: {}, model: "y", supportedParameters: ["reasoning"] }), true)
  assert.equal(modelThinkingSupport({ config: {}, model: "o3-mini" }), true, "名族启发式")
  assert.equal(modelThinkingSupport({ config: {}, model: "totally-unknown" }), null, "拿不准就说拿不准")
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
