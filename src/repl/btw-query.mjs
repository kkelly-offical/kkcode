import { getConversationHistory } from "../session/store.mjs"
import { requestProvider } from "../provider/router.mjs"

/**
 * `/btw`：顺便问一下。
 *
 * ## 它跟直接发一句话有什么不同
 *
 * 用户干到一半想问「这个 flag 是干嘛的」。直接发出去的代价是：问题和答案永久留在
 * 会话历史里，之后每一轮都要重新发一遍给模型；模型还可能顺手去 read 几个文件、
 * 改点东西 —— 一个只想要一句解释的问题，变成了一次工具回合。
 *
 * 所以旁路问答的四条约束是一体的，缺一条就退化成普通提问：
 *
 * 1. **看得见历史** —— 不然「这个 flag」指代不明，用户还得自己复述上下文
 * 2. **不改历史** —— 这里不碰 `appendMessage` / `touchSession`，一行都不写
 * 3. **禁工具** —— `tools: []`，模型只能用已知的东西答，答不了就说答不了
 * 4. **不带主 system prompt** —— 主 prompt 里全是「你是一个编码 agent，要用工具
 *    完成任务」，带上它就是在要求模型做它这次做不到的事
 *
 * 答案由调用方渲染到只读浮层，同样不进 transcript。
 *
 * ## 为什么必须把 tool_use / tool_result 转成文本
 *
 * 不只是省 token。Anthropic 在 `messages` 里出现 `tool_use` / `tool_result` 块而
 * `tools` 为空时会直接 400。也就是说「带上历史」和「禁工具」这两条约束**在原样
 * 转发时是互斥的** —— `trimForBtw` 就是化解这一点的地方，不是可选的优化。
 */

/** 旁路专用 system。刻意短：它要压过历史里那些「去改文件」的语气。 */
export const BTW_SYSTEM_PROMPT =
  "You are answering a quick side question about the ongoing conversation. Be concise. Do not use tools."

export const DEFAULT_MAX_CONTEXT_MESSAGES = 40

const TOOL_RESULT_PLACEHOLDER = "[tool result omitted]"
const IMAGE_PLACEHOLDER = "[image omitted]"
const EXCERPT_MARKER = "[earlier conversation omitted]"

/**
 * 一个内容块 → 一行文本。返回空串表示这块整个丢掉。
 *
 * 兜底是**丢弃**而不是 JSON.stringify：认不出的块最可能的形状就是又一种带
 * base64 载荷的东西（各家 provider 的图片块字段名都不一样），字符串化等于把
 * 刚剥掉的几 MB 原样塞回去。
 */
function blockToText(block) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object") return ""
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : ""
    case "tool_use":
      // 保留「调过什么工具」这一点线索：用户问「刚才为什么读那个文件」时用得上，
      // 而 input 里的参数（可能是整个文件内容）不带。
      return `[tool call: ${block.name || "unknown"}]`
    case "tool_result":
      return TOOL_RESULT_PLACEHOLDER
    case "image":
      return IMAGE_PLACEHOLDER
    // reasoning / thinking：跨轮转发时各家的签名校验规则不一样，带上只会 400
    case "reasoning":
    case "thinking":
    case "redacted_thinking":
      return ""
    default:
      return ""
  }
}

/**
 * 把会话历史裁成能安全发出去的一段。**纯函数**，规则全在这里，好单测。
 *
 * - 只留最近 `max` 条（裁掉的是旧的）
 * - 只留 user / assistant
 * - 每条压成一个字符串：tool_result 与图片换成占位符，思考块丢掉
 * - 丢掉压完为空的（provider 一律拒收空 content）
 * - 首条是 assistant 时补一条 user 标记（Anthropic 要求首条是 user，而按尾部
 *   切片很容易切在 assistant 上）。补而不是丢：那条 assistant 往往正是用户
 *   「顺便问一下」所指的那句话。
 */
export function trimForBtw(messages, max = DEFAULT_MAX_CONTEXT_MESSAGES) {
  if (!Array.isArray(messages)) return []
  const limit = Number(max)
  // `slice(-0)` 返回整个数组 —— 这里必须显式挡掉，否则 max=0 会变成「全都带上」
  if (!Number.isFinite(limit) || limit <= 0) return []

  const usable = messages.filter((msg) => msg && (msg.role === "user" || msg.role === "assistant"))
  const flattened = []
  for (const msg of usable.slice(-Math.floor(limit))) {
    const content = Array.isArray(msg.content)
      ? msg.content.map(blockToText).filter(Boolean).join("\n")
      : typeof msg.content === "string" ? msg.content : ""
    const text = content.trim()
    if (text) flattened.push({ role: msg.role, content: text })
  }

  if (flattened.length && flattened[0].role !== "user") {
    flattened.unshift({ role: "user", content: EXCERPT_MARKER })
  }
  return flattened
}

/**
 * 失败原因 → 一句用户能照着做的话。
 *
 * router 那边「没有配置任何 provider」之类的消息本来就写好了下一步，原样透出；
 * 只有取消和空消息需要在这里补。
 */
function describeFailure(error, signal) {
  if (signal?.aborted) return "已取消"
  const message = String(error?.message || "").trim()
  if (!message) return "旁路提问失败：上游没有给出原因"
  return `旁路提问失败：${message}`
}

async function defaultLoadMessages(sessionId, limit) {
  return getConversationHistory(sessionId, limit)
}

/**
 * 问一句、拿一句。永远 resolve —— 调用方是个浮层，没有地方接异常。
 *
 * `loadMessages` / `request` 是注入点（测试喂假的），默认接真的会话存储与
 * provider 路由。注意默认的读取走 `getConversationHistory`，不在这里另写一份
 * 会话读取逻辑 —— 那份还带着「压缩摘要永远不被切掉」的规则。
 */
export async function runBtwQuery({
  question,
  sessionId = null,
  state = {},
  configState = null,
  loadMessages = null,
  request = null,
  maxContextMessages = DEFAULT_MAX_CONTEXT_MESSAGES,
  signal = null
} = {}) {
  const prompt = String(question ?? "").trim()
  if (!prompt) return { ok: false, error: "用法：/btw <问题>" }

  const load = loadMessages || defaultLoadMessages
  const send = request || requestProvider

  // 历史读不出来不该让问题问不成 —— 没上下文的旁路提问仍然是有意义的，
  // 而「会话文件坏了」这件事有别的地方报。
  let history = []
  if (sessionId) {
    try {
      history = await load(sessionId, maxContextMessages)
    } catch {
      history = []
    }
  }

  try {
    const response = await send({
      configState,
      providerType: state.providerType,
      model: state.model,
      system: BTW_SYSTEM_PROMPT,
      messages: [...trimForBtw(history, maxContextMessages), { role: "user", content: prompt }],
      tools: [],
      // sessionId 只进审计链（kk.audit.v1），那是另一本账 —— 会话记录仍然不动
      sessionId,
      signal
    })
    const answer = String(response?.text || "").trim()
    if (!answer) return { ok: false, error: "模型没有返回内容，换个问法再试一次" }
    return { ok: true, answer }
  } catch (error) {
    return { ok: false, error: describeFailure(error, signal) }
  }
}
