import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"

/**
 * Issue #3：配置里写了内联 api_key 时，provider 向导只查环境变量。
 *
 * 0.7.3 表单化之后这条语义的落点变了，但**不能丢**：
 *  1. 对已有 provider 重跑 `/provider add`、密钥题留空时，模型发现必须用配置里
 *     已有的内联 api_key —— 用户不该因为「没重打一遍密钥」而被降级到手动输入。
 *  2. 写回仍是逐字段合并 —— 重跑表单不能把没动过的字段（内联 api_key、超时
 *     调优、models 列表）抹掉。这条测的是 saveProviderConfig 本身，与交互无关。
 */

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-wizard-key-"))
process.env.KKCODE_HOME = tmpHome

const { runProviderAddForm } = await import("../src/provider/wizard-form.mjs")
const { saveProviderConfig } = await import("../src/provider/wizard.mjs")

/** 逐题回答；没写的题用它的 default（等于直接回车）。 */
const scriptedAsk = (answerBook) => async ({ questions }) => {
  const out = {}
  for (const q of questions) {
    out[q.id] = Object.prototype.hasOwnProperty.call(answerBook, q.id)
      ? answerBook[q.id]
      : (q.default ?? "")
  }
  return out
}

test.after(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

test("重跑 add 且密钥题留空时，发现用配置里已有的内联 api_key（issue #3 的表单形态）", async () => {
  delete process.env.KIMI_CODE_API_KEY
  const discovered = []
  const result = await runProviderAddForm({
    configState: {
      config: {
        provider: {
          "kimi-code": { api_key: "sk-kimi-inline-secret", base_url: "https://api.kimi.com/coding/v1" }
        }
      }
    },
    ask: scriptedAsk({
      vendor: "kimi-code",
      api_key: "",          // 留空 —— 关键场景：用户不想重打一遍已配好的密钥
      model: "k3",
      confirm: "save"
    }),
    discover: async (configState) => {
      discovered.push(configState.config.provider["kimi-code"])
      return { models: [{ id: "k3" }, { id: "kimi-for-coding" }] }
    }
  })
  assert.equal(result.saved, true)
  assert.equal(discovered[0].api_key, "sk-kimi-inline-secret", "内联密钥必须传进发现请求")
  // 只进发现的 draft，不因此把 key 重写一遍 —— 写盘留给 merge 保留旧值
  assert.equal(result.configPatch.provider["kimi-code"].api_key, undefined)
})

test("既无输入也无内联密钥时，发现失败降级到手动输入而不是报错中断", async () => {
  delete process.env.KIMI_CODE_API_KEY
  const modelQuestionRounds = []
  const result = await runProviderAddForm({
    configState: { config: { provider: {} } },
    ask: async ({ questions }) => {
      if (questions.some((q) => q.id === "model")) modelQuestionRounds.push(questions)
      return Object.fromEntries(questions.map((q) => {
        if (q.id === "vendor") return [q.id, "kimi-code"]
        if (q.id === "api_key") return [q.id, ""]
        if (q.id === "model") return [q.id, "k3"]
        if (q.id === "confirm") return [q.id, "save"]
        if (q.id === "thinking") return [q.id, "skip"]
        return [q.id, q.default ?? ""]
      }))
    },
    // 无凭据时目录发现抛错 —— 表单应当把它当「没有列表」而不是把流程打断
    discover: async () => { throw new Error("KIMI_CODE_API_KEY is not set") }
  })
  assert.equal(result.saved, true)
  assert.equal(modelQuestionRounds.length, 1, "降级后只该有手动输入这一轮")
  assert.equal(modelQuestionRounds[0].find((q) => q.id === "model").options, undefined)
  // 预设有 key_env 且用户没给明文 → 写环境变量名（运行时的凭据来源，必要信息）
  assert.equal(result.configPatch.provider["kimi-code"].api_key_env, "KIMI_CODE_API_KEY")
})

test("saveProviderConfig 逐字段合并：重跑不会抹掉没动过的字段", async () => {
  const configPath = path.join(tmpHome, "config.yaml")
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, YAML.stringify({
    provider: {
      default: "kimi-code",
      "kimi-code": {
        type: "openai-compatible",
        base_url: "https://api.kimi.com/coding/v1",
        api_key: "sk-kimi-inline-secret",
        models: ["k3", "kimi-for-coding"],
        timeout_ms: 180000,
        retry_attempts: 3
      },
      aliyun: { type: "openai-compatible", base_url: "https://x/v1", api_key: "sk-other" }
    }
  }), "utf8")

  // 表单只改 default_model —— 与旧向导「只保存用户动过的字段」同一形状
  await saveProviderConfig({ provider: { "kimi-code": { default_model: "k3-256k" } } }, false)

  const saved = YAML.parse(await readFile(configPath, "utf8"))
  const entry = saved.provider["kimi-code"]
  assert.equal(entry.default_model, "k3-256k")
  // 0.5.0 之前这三行会失败：整条目替换把它们全抹了
  assert.equal(entry.api_key, "sk-kimi-inline-secret", "内联密钥不能被抹掉")
  assert.equal(entry.timeout_ms, 180000, "调优字段不能被抹掉")
  assert.deepEqual(entry.models, ["k3", "kimi-for-coding"], "models 列表不能被抹掉")
  assert.equal(saved.provider.aliyun.api_key, "sk-other", "其它 provider 不受影响")
})

test("saveProviderConfig 合并 model_context：新模型的上下文不会抹掉已有的条目", async () => {
  // 0.7.4 起表单会把发现到的上下文写进 provider.model_context。那是个**顶层 map**
  // （不是 provider 条目内的字段），整段替换的话，再加一个 provider 就会把之前
  // 攒下的所有模型上下文清掉 —— 而这件事没有任何报错，只会在下次压缩时算错阈值。
  const configPath = path.join(tmpHome, "config.yaml")
  await writeFile(configPath, YAML.stringify({
    provider: {
      default: "kimi-code",
      model_context: { k3: 1048576, "gpt-4o": 128000 },
      "kimi-code": { type: "openai-compatible" }
    }
  }), "utf8")

  await saveProviderConfig({
    provider: {
      default: "deepseek",
      deepseek: { type: "openai-compatible", default_model: "deepseek-chat", models: ["deepseek-chat"] },
      model_context: { "deepseek-chat": 65536 }
    }
  }, true)

  const mc = YAML.parse(await readFile(configPath, "utf8")).provider.model_context
  assert.equal(mc["deepseek-chat"], 65536, "新模型的上下文要写进去")
  assert.equal(mc.k3, 1048576, "已有条目不能被抹掉")
  assert.equal(mc["gpt-4o"], 128000, "已有条目不能被抹掉")
})
