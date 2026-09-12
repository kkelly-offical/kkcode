import { executeTurn } from "../session/engine.mjs"
import { HookBus } from "../plugin/hook-bus.mjs"
import { extractImageRefs, buildContentBlocks } from "../kernel/tool/image-util.mjs"
import { handleRollbackIfNeeded } from "../session/rollback.mjs"

export async function executePromptTurn({
  prompt,
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
    || (kernelHooks ? kernelHooks.chatParams.bind(kernelHooks) : HookBus.chatParams.bind(HookBus))
  const executeTurnFn = deps.executeTurn || executeTurn
  const handleRollbackFn = deps.handleRollbackIfNeeded || handleRollbackIfNeeded
  const cwd = deps.cwd || process.cwd()

  const { text: cleanedPrompt, imagePaths, imageUrls = [] } = extractImageRefsFn(prompt, cwd)
  const effectivePrompt = cleanedPrompt ?? prompt

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
      if (img && img.type === "image") contentBlocks.push(img)
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
