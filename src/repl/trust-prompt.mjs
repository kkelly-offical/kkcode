import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

/**
 * 工作区信任的启动询问（前端侧实现，1.0.0 阶段 3b）。
 *
 * 内核的 checkWorkspaceTrust 不再碰 TTY：这里把「行式提问」作为 prompt
 * 回调注入给它。调用时点在 TUI 激活之前，stdin 此时还是普通的行模式，
 * 与迁移前内嵌在 permission/workspace-trust.mjs 里的实现逐字同构。
 */
export async function promptWorkspaceTrust(question) {
  const rl = createInterface({ input, output })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}
