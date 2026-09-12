import { runHybridLongAgent } from "./longagent-hybrid.mjs"

/**
 * Ultra 模式入口。
 *
 * 0.3.x 这里有三套实现：hybrid（默认）、4stage（默认关闭、无 checkpoint
 * 无并行无 replan）、parallel（无法显式选中的降级路径）。0.4.0 只保留
 * hybrid —— 它是唯一具备断点恢复、阶段并行、replan、TaskBus 与上下文压缩
 * 的实现，另外两套既无人可达也无法维护对等能力。
 *
 * 随之移除的还有 `/longagent 4stage|hybrid` 子命令与 `state.longagentImpl`。
 */
export async function runLongAgent(args) {
  return runHybridLongAgent(args)
}
