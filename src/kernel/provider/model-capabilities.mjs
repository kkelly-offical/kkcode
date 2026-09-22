/**
 * 模型能力标记：目录条目解析、名字族启发式与请求路径执行。
 *
 * 这是「填完 Base URL + API key 就尽量自动加载模型全部参数」的解析层。
 * 能力数据的三个来源按优先级合并（合并逻辑在 model-catalog.mjs 的
 * resolveModelCapabilities，本文件只放纯函数）：
 *
 *   1. 配置的 provider.model_capabilities（/provider add 探测写入或用户手改）
 *   2. 目录发现缓存里该模型的自报能力（/models 条目的 modalities 等字段）
 *   3. 模型名族启发式（只认把握大的家族，拿不准就是「未知」）
 *
 * 「未知」与「不支持」是两回事：未知 = 保持既有行为（放行，与没有能力
 * 系统之前完全一致）；只有确知 false 才在请求路径上拦截/降级。目录不报
 * 能力的供应商不会因为我们的猜测而坏掉。
 */

import { ProviderError } from "../core/errors.mjs"

/** 能力标记的全集 —— schema 校验与 wizard 预览都从这份清单派生，不手抄。 */
export const MODEL_CAPABILITY_KEYS = Object.freeze(["image", "video", "audio", "tools", "streaming", "reasoning"])

const CAPABILITY_SET = new Set(MODEL_CAPABILITY_KEYS)

/** 配置/缓存里读出的能力对象 → 只含已知布尔键的干净副本。非法输入折成 {}。
 * @param {any} value
 * @returns {Record<string, boolean>} */
export function normalizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out = {}
  for (const key of MODEL_CAPABILITY_KEYS) {
    if (typeof value[key] === "boolean") out[key] = value[key]
  }
  return out
}

/** 输入模态列表 → 三个媒体能力。列表存在本身就是「供应商枚举过输入模态」的证据。 */
function readModalities(item, into) {
  const candidates = [
    item?.architecture?.input_modalities,
    item?.architecture?.inputModalities,
    item?.input_modalities,
    item?.inputModalities,
    item?.modalities?.input
  ]
  let list = null
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      list = candidate.map((entry) => String(entry).toLowerCase())
      break
    }
  }
  // OpenRouter 的另一种形态："text+image->text"
  if (!list) {
    const modality = item?.architecture?.modality
    if (typeof modality === "string" && modality.includes("->")) {
      list = modality.split("->")[0].split("+").map((part) => part.trim().toLowerCase()).filter(Boolean)
    }
  }
  if (!list) return
  into.image = list.includes("image")
  into.video = list.includes("video")
  into.audio = list.includes("audio")
}

/** supported_parameters 枚举 → tools / reasoning。与 supportsThinking 同一条判据。 */
function readSupportedParameters(item, into) {
  const raw = Array.isArray(item?.supported_parameters) ? item.supported_parameters
    : Array.isArray(item?.supportedParameters) ? item.supportedParameters
      : null
  if (!raw) return
  const list = raw.map((entry) => String(entry).toLowerCase())
  into.tools = list.some((p) => p === "tools" || p === "tool_choice" || p === "functions")
  into.reasoning = list.some((p) => /reasoning|thinking/.test(p))
}

/** 各家自报的 capabilities 对象（含我们自己缓存轮次里的归一化形态）。 */
function readCapabilityObject(item, into) {
  const bag = item?.capabilities
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return
  const keys = {
    image: ["image", "vision", "image_input", "imageInput"],
    video: ["video", "video_input", "videoInput"],
    audio: ["audio", "audio_input", "audioInput"],
    tools: ["tools", "function_calling", "functionCalling", "tool_use", "toolUse"],
    streaming: ["streaming", "stream"],
    reasoning: ["reasoning", "thinking"]
  }
  for (const [capability, aliases] of Object.entries(keys)) {
    for (const alias of aliases) {
      if (typeof bag[alias] === "boolean") {
        into[capability] = bag[alias]
        break
      }
    }
  }
}

/**
 * 从 /models 目录条目解析能力标记。只写拿得到证据的键，全无证据返回 null。
 *
 * 覆盖的上游形态：OpenRouter 的 architecture.input_modalities / modality /
 * supported_parameters / pricing 一带的字段、扁平的 input_modalities、以及
 * 各家自报的 capabilities 对象。我们写进磁盘缓存的归一化条目（capabilities
 * 已是干净布尔 map）走同一条路，于是缓存回放不会丢能力。
 *
 * @param {any} item
 * @returns {Record<string, boolean> | null}
 */
export function parseCatalogEntryCapabilities(item) {
  if (!item || typeof item !== "object") return null
  const into = {}
  readCapabilityObject(item, into)
  readModalities(item, into)
  readSupportedParameters(item, into)
  return Object.keys(into).length ? into : null
}

/**
 * 从目录条目解析定价，统一成「每 1M tokens 的 USD 单价」—— 与 usage/pricing.mjs
 * 的 DEFAULT_PRICING 同一口径，下游不用再换算。
 *
 * 两种来源：OpenRouter 的 pricing.prompt/completion（每 token 的 USD 字符串），
 * 以及我们自己缓存里的归一化形态（pricing.input/output，已是每 1M）。
 * 拿不到或畸形返回 null —— 定价是「如可获取」，编一个数比没有更糟。
 */
export function parseCatalogEntryPricing(item) {
  const pricing = item?.pricing
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return null
  const input = Number(pricing.input)
  const output = Number(pricing.output)
  if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
    return {
      input,
      output,
      currency: typeof pricing.currency === "string" && pricing.currency ? pricing.currency : "USD",
      perTokens: 1000000
    }
  }
  const prompt = Number(pricing.prompt)
  const completion = Number(pricing.completion)
  if (Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0) {
    return { input: prompt * 1e6, output: completion * 1e6, currency: "USD", perTokens: 1000000 }
  }
  return null
}

/**
 * 模型名族启发式 —— 只认把握大的家族，拿不准一律 {}（= 未知，放行）。
 *
 * 与 thinking-effort.mjs 的 supportsThinking 是同一种妥协：目录与配置都
 * 没有时给个兜底判断。false 名单刻意很短（确认文本-only 的家族），猜错
 * 「不支持」的代价是拦住用户本来能用的图。
 *
 * @param {string} modelId
 * @returns {Record<string, boolean>}
 */
export function inferCapabilitiesFromName(modelId) {
  const id = String(modelId || "").toLowerCase()
  if (!id) return {}
  if (/(^|[^a-z0-9])deepseek-(chat|reasoner|v3|v4)/.test(id)) return { image: false }
  if (/(^|[^a-z0-9])moonshot-v1-(8k|32k|128k)$/.test(id)) return { image: false }
  if (/(^|[^a-z0-9])(gpt-4o|gpt-4\.1|gpt-5|chatgpt|o4-|claude-[3-9]|claude-(opus|sonnet|haiku|fable)|gemini-|grok-4|grok-2-vision|pixtral|qwen[0-9.]*-vl|qwen3\.5|qwen-plus|qwen-max|qwen-omni|glm-4v|glm-4\.5|glm-5|kimi-k2\.[5-9]|kimi-latest|minimax-m2|doubao-seed|doubao-vision)/.test(id)) {
    return { image: true }
  }
  return {}
}

const imagePlaceholder = (model) =>
  `[image withheld: model "${model}" does not support image input]`

/**
 * 请求路径的能力执行：模型确知不支持时，把对应输入拦在出门之前。
 *
 * 两条不同的处置，按图片在会话里的位置分开：
 *   - 本轮**新输入**（最后一条 user 消息、不带 tool_result 块）里的图片 →
 *     直接抛错。用户刚贴的图被静默丢掉是最坏的形态，必须当场说清。
 *   - 历史消息与工具结果（read 读图挂在 tool_result 之后的同一条 user 消息）
 *     里的图片 → 降级成占位文本。换到文本模型不该让带着图的旧会话再也发不出
 *     消息；占位文本让模型知道「这里本来有一张图」。
 *
 * video/audio 块今天没有生产者、adapter 也没有对应的请求体构造 —— 落到
 * adapter 会被 map 成空文本静默消失，所以在这里一律换成说人话的占位。
 *
 * tools 确知 false 时把工具从请求里摘掉（发给不收 tools 的接口只会换来
 * 400），由调用方告警 —— 纯函数不写日志，丢弃数量通过返回值交出去。
 *
 * @param {object} p
 * @param {any[]} [p.messages]
 * @param {any[]} [p.tools]
 * @param {Record<string, boolean>} [p.capabilities]
 * @param {string} [p.provider]
 * @param {string} [p.model]
 * @returns {{ messages: any[], tools: any[], droppedImages: number, droppedMedia: number, droppedTools: number }}
 */
export function enforceModelInputCapabilities({ messages, tools = [], capabilities = {}, provider = "", model = "" } = {}) {
  const caps = capabilities && typeof capabilities === "object" ? capabilities : {}
  let outMessages = Array.isArray(messages) ? messages : []
  let droppedImages = 0
  let droppedMedia = 0

  const imageBlocks = (message) => Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === "image" && block?.data)
    : []
  const isFreshUserMessage = (message) => message?.role === "user"
    && Array.isArray(message?.content)
    && !message.content.some((block) => block?.type === "tool_result")

  if (caps.image === false && outMessages.some((message) => imageBlocks(message).length)) {
    const last = outMessages[outMessages.length - 1]
    if (isFreshUserMessage(last) && imageBlocks(last).length) {
      throw new ProviderError(
        `model "${model}" does not support image input — remove the image or switch to a vision-capable model (provider.model_capabilities can override this verdict)`,
        { provider, model, reason: "unsupported_capability", capability: "image" }
      )
    }
    outMessages = outMessages.map((message) => {
      const blocks = imageBlocks(message)
      if (!blocks.length) return message
      droppedImages += blocks.length
      return {
        ...message,
        content: message.content.map((block) =>
          block?.type === "image" && block?.data ? { type: "text", text: imagePlaceholder(model) } : block)
      }
    })
  }

  const hasForeignMedia = outMessages.some((message) => Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "video" || block?.type === "audio"))
  if (hasForeignMedia) {
    outMessages = outMessages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => {
          const kind = block?.type
          if (kind !== "video" && kind !== "audio") return block
          droppedMedia += 1
          const text = caps[kind] === false
            ? `[${kind} withheld: model "${model}" does not support ${kind} input]`
            : `[${kind} withheld: this client cannot encode ${kind} input yet]`
          return { type: "text", text }
        })
      }
    })
  }

  let outTools = Array.isArray(tools) ? tools : []
  let droppedTools = 0
  if (caps.tools === false && outTools.length) {
    droppedTools = outTools.length
    outTools = []
  }

  return { messages: outMessages, tools: outTools, droppedImages, droppedMedia, droppedTools }
}
