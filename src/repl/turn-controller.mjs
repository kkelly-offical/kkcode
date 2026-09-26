import { executeTurn, defaultHookBus, extractImageRefs, buildContentBlocks, handleRollbackIfNeeded, isImagePath, normalizeDroppedPath } from "../kernel/index.mjs"
import path from 'node:path'
import { scanMentions } from './file-mention.mjs'

function extractUserImages(source, cwd, extract) {
  // A text filename may itself contain @photo.png or a URL. Treat each complete
  // non-image mention as literal text, not another source of image references.
  const tokens = scanMentions(source)
  if (!tokens.length) return extract(source, cwd)
  let cursor = 0, text = ''
  const imagePaths = new Set(), imageUrls = new Set()
  const append = chunk => {
    if (!chunk) return
    const result = extract(chunk, cwd, { preserveWhitespace: true })
    text += result.text ?? chunk
    for (const value of result.imagePaths || []) imagePaths.add(value)
    for (const value of result.imageUrls || []) imageUrls.add(value)
  }
  for (const token of tokens) {
    append(source.slice(cursor, token.start))
    if (/^https?:\/\//i.test(token.query)) append(source.slice(token.start, token.end))
    else if (isImagePath(token.query)) imagePaths.add(path.resolve(cwd, normalizeDroppedPath(token.query, { literal: true })))
    else text += source.slice(token.start, token.end)
    cursor = token.end
  }
  append(source.slice(cursor))
  return { text, imagePaths: [...imagePaths], imageUrls: [...imageUrls] }
}

export async function executePromptTurn({
  prompt,
  imageReferenceLength = null,
  state,
  ctx,
  streamSink = null,
  pendingImages = [],
  signal = null,
  toolContext = {},
  steerSource = null,
  deps = {}
}) {
  const extractImageRefsFn = deps.extractImageRefs || extractImageRefs
  const buildContentBlocksFn = deps.buildContentBlocks || buildContentBlocks
  // 2b 过渡期进程级默认 HookBus 要到 loop 里才懒初始化；首回合的 chat.params
  // 钩子会被静默跳过。kernel 实例的 hooks 在 createKernel 时已装好，优先走句柄
  // （1.0.0 阶段 2c）；无句柄的调用方（测试、旧路径）保持原默认。
  const kernelHooks = ctx?.kernel?.extensions?.hooks
  const chatParamsFn = deps.chatParams
    || (kernelHooks ? kernelHooks.chatParams.bind(kernelHooks) : defaultHookBus.chatParams.bind(defaultHookBus))
  // 阶段 4（耦合点 11 核销）：回合执行与回滚拦截优先走 kernel 句柄；句柄的
  // executeTurn 在缺省时注入 configState/output，这里两者都显式给足，等价。
  const executeTurnFn = deps.executeTurn
    || (ctx?.kernel ? ctx.kernel.executeTurn : null)
    || executeTurn
  const handleRollbackFn = deps.handleRollbackIfNeeded
    || (ctx?.kernel?.sessions?.handleRollbackIfNeeded ?? null)
    || handleRollbackIfNeeded
  const cwd = deps.cwd || process.cwd()

  const source = String(prompt ?? '')
  const referenceEnd = imageReferenceLength ?? source.length
  if (!Number.isInteger(referenceEnd) || referenceEnd < 0 || referenceEnd > source.length) throw new TypeError('Invalid user image-reference boundary')
  const { text: cleanedPrompt, imagePaths, imageUrls = [] } = extractUserImages(source.slice(0, referenceEnd), cwd, extractImageRefsFn)
  const effectivePrompt = (cleanedPrompt ?? source.slice(0, referenceEnd)) + source.slice(referenceEnd)

  // 自然语言撤销只在前台 REPL 的真实用户回合入口处拦截。放在
  // processTurnLoop 里会误伤子代理/Ultra 内部提示词中的 rollback 字样；
  // 放在模型请求之后又已经太晚。这里拥有前台 sessionId、cwd 和语言，
  // 因此能在不启动 provider 的情况下安全收口。
  const rollback = await handleRollbackFn({
    prompt: effectivePrompt,
    cwd,
    sessionId: state.sessionId,
    language: ctx.configState.config.language || "en"
  })
  if (rollback.handled) {
    return {
      result: {
        reply: rollback.reply,
        mode: state.mode,
        model: state.model,
        sessionId: state.sessionId,
        turnId: null,
        emittedText: false,
        context: null,
        tokenMeter: null,
        cost: 0,
        costSavings: 0,
        pricingWarnings: [],
        budgetWarnings: [],
        budgetExceeded: false,
        toolEvents: [],
        planHandoff: null,
        longagent: null
      }
    }
  }

  let contentBlocks = null

  if (imagePaths.length || imageUrls.length || pendingImages.length) {
    contentBlocks = await buildContentBlocksFn(effectivePrompt, imagePaths, imageUrls)
    if (typeof contentBlocks === "string") {
      contentBlocks = [{ type: "text", text: contentBlocks }]
    }
    for (const img of pendingImages) {
      // 图像/视频/语音块都放行 —— 收不收得下的判定在 UI 的 attachment-input
      // （模型能力面），不支持的根本到不了这里。
      if (img && (img.type === "image" || img.type === "video" || img.type === "audio")) contentBlocks.push(img)
    }
  }

  const chatParams = await chatParamsFn({
    prompt: effectivePrompt,
    mode: state.mode,
    model: state.model,
    providerType: state.providerType,
    sessionId: state.sessionId
  })

  return {
    result: await executeTurnFn({
      prompt: chatParams.prompt ?? effectivePrompt,
      contentBlocks,
      mode: chatParams.mode ?? state.mode,
      model: chatParams.model ?? state.model,
      sessionId: state.sessionId,
      configState: ctx.configState,
      providerType: chatParams.providerType ?? state.providerType,
      signal,
      toolContext,
      steerSource,
      output: streamSink && typeof streamSink === "function"
        ? { write: streamSink, renderMarkdown: false }
        : null
    })
  }
}
