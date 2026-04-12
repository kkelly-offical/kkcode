import { executeTurn } from "../session/engine.mjs"
import { HookBus } from "../plugin/hook-bus.mjs"
import { extractImageRefs, buildContentBlocks } from "../tool/image-util.mjs"

export async function executePromptTurn({
  prompt,
  state,
  ctx,
  streamSink = null,
  pendingImages = [],
  signal = null,
  deps = {}
}) {
  const extractImageRefsFn = deps.extractImageRefs || extractImageRefs
  const buildContentBlocksFn = deps.buildContentBlocks || buildContentBlocks
  const chatParamsFn = deps.chatParams || HookBus.chatParams.bind(HookBus)
  const executeTurnFn = deps.executeTurn || executeTurn
  const cwd = deps.cwd || process.cwd()

  const { text: cleanedPrompt, imagePaths, imageUrls = [] } = extractImageRefsFn(prompt, cwd)
  const effectivePrompt = cleanedPrompt ?? prompt
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
      longagentImpl: state.longagentImpl ?? null,
      signal,
      output: streamSink && typeof streamSink === "function"
        ? { write: streamSink }
        : null
    })
  }
}
