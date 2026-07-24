import { requestFast, isFastModelConfigured } from "../provider/fast-model.mjs"
import { getAgentPrompt } from "../agent/agent.mjs"
import { updateSession, getSession } from "./store.mjs"
import { sanitizeTerminalText } from "../theme/terminal-sanitize.mjs"

const MAX_TITLE_LENGTH = 50

/**
 * 用 fast 小模型把会话标题从「首条 prompt 的前 50 字符截断」升级为一句概括。
 *
 * `title` agent 自 0.2.x 就定义在 agent 注册表里却一直没有任何调用方；
 * 0.4.0 的 models.fast 通道正好是它该走的路径。
 *
 * 三条约束：未配置 models.fast 就什么都不做；只覆盖自动生成的标题，不动
 * 用户改过的；失败一律静默，绝不影响这一轮对话。
 */
export async function refineSessionTitle({
  configState,
  sessionId,
  prompt,
  providerType = null,
  autoTitle = "",
  deps = {}
}) {
  if (!isFastModelConfigured(configState)) return null
  if (!String(prompt || "").trim()) return null

  const request = deps.requestFast || requestFast
  const read = deps.getSession || getSession
  const write = deps.updateSession || updateSession

  try {
    const session = await read(sessionId)
    // 用户改过标题就不要覆盖
    if (session?.title && autoTitle && session.title !== autoTitle) return null

    const system = deps.systemPrompt || (await getAgentPrompt("title"))
    const raw = await request({
      configState,
      providerType,
      system,
      prompt: String(prompt).slice(0, 2000),
      maxTokens: 32
    })
    const title = normalizeTitle(raw)
    if (!title) return null

    await write(sessionId, { title })
    return title
  } catch {
    return null
  }
}

/** 单行、限长、去掉包裹引号，并过掉终端控制字符。 */
export function normalizeTitle(raw) {
  const firstLine = String(raw || "").split("\n").find((line) => line.trim()) || ""
  const stripped = sanitizeTerminalText(firstLine)
    .trim()
    .replace(/^["'“”『「]+|["'“”』」]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!stripped) return ""
  return stripped.slice(0, MAX_TITLE_LENGTH)
}
