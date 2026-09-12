import { readFile, stat } from "node:fs/promises"
import { getFileReadState, extractTrackedView } from "./file-read-state.mjs"

function missingReadMessage(displayPath, operation) {
  return `error: "${displayPath}" has not been read yet. Read it first before ${operation}.`
}

function partialReadMessage(displayPath, operation) {
  return `error: "${displayPath}" was only partially read. Read the full file before ${operation}.`
}

function staleReadMessage(displayPath, operation) {
  return `error: "${displayPath}" has changed since it was last read. Read it again before ${operation}.`
}

function missingFileMessage(displayPath, operation) {
  return `error: "${displayPath}" no longer exists. Re-read the latest workspace state before ${operation}.`
}

/**
 * 外部改动后的降级放行。
 *
 * 硬失败的问题：kkcode 本身就是多 agent 的，同一文件被另一个 agent 或用户的
 * 编辑器碰一下（哪怕改的是文件另一头），当前这次编辑就整个被拒，模型只能重读
 * 全文再来一遍。Claude Code 在 v2.1.208 专门做了这个降级，理由是多 agent
 * 场景下硬失败的误杀率很高。
 *
 * 三个条件同时成立才放行，缺一不可：
 *
 *   1. 锚点在**新内容**里精确且唯一匹配
 *   2. 锚点在**读到的旧内容**里也精确且唯一匹配
 *   3. 锚点所跨的**整行**在新旧内容里逐字节相同
 *
 * 第 3 条不能省。只判「唯一匹配」时，锚点 `const a = 1` 会命中被外部改成
 * `const a = 10` 的那一行 —— 确实只有一处，但那已经不是同一个 token 了，
 * 替换结果会静默变成 `const a = 20`，而模型完全不知道。整行相同才能证明
 * 「锚点指的还是那个东西」，别处怎么改都不影响。
 */
function anchorLines(content, anchor) {
  const index = String(content).indexOf(anchor)
  if (index === -1) return null
  const text = String(content)
  const lineStart = text.lastIndexOf("\n", index) + 1
  const anchorEnd = index + anchor.length
  const nextBreak = text.indexOf("\n", anchorEnd)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  return text.slice(lineStart, lineEnd)
}

function staleButAnchorIntact(currentContent, previousContent, anchor) {
  const text = String(anchor ?? "")
  if (!text) return false
  if (String(currentContent).split(text).length - 1 !== 1) return false
  if (String(previousContent ?? "").split(text).length - 1 !== 1) return false
  const before = anchorLines(previousContent, text)
  const after = anchorLines(currentContent, text)
  return before !== null && before === after
}

function staleAllowedMessage(displayPath) {
  return `note: "${displayPath}" changed since it was last read, but your anchor still matches exactly once, `
    + "so the edit was applied. Re-read the file before further edits."
}

export async function validateExistingFileMutation({
  targetPath,
  displayPath,
  operation,
  requireFullRead = false,
  // 这次编辑要定位的原文（edit 的 before / patch 的锚点）。传了它才可能走
  // 「外部改动但锚点仍唯一」的降级；不传就是旧的硬失败语义 —— write 之类
  // 整文件替换的操作没有锚点可言，本来就该硬失败。
  anchor = ""
}) {
  const readState = getFileReadState(targetPath)
  const label = String(displayPath || targetPath)
  const action = String(operation || "modifying it")

  if (!readState) {
    return { ok: false, reason: "unread", message: missingReadMessage(label, action) }
  }

  if (requireFullRead && readState.isPartialView) {
    return { ok: false, reason: "partial_read", message: partialReadMessage(label, action) }
  }

  try {
    const fileStat = await stat(targetPath)
    const currentTimestamp = Math.floor(fileStat.mtimeMs)
    const currentContent = await readFile(targetPath, "utf8")
    const currentTrackedView = extractTrackedView(currentContent, readState)
    if (currentTrackedView === readState.content) {
      return { ok: true, readState, currentTimestamp, currentContent }
    }

    // 文件被外部改过。若这次编辑的锚点在新内容里仍精确且唯一匹配，
    // 落点没有歧义 —— 放行并提示，而不是让模型重读整个文件再来一轮。
    if (staleButAnchorIntact(currentContent, readState.content, anchor)) {
      return {
        ok: true,
        readState,
        currentTimestamp,
        currentContent,
        staleAnchorIntact: true,
        notice: staleAllowedMessage(label)
      }
    }

    return { ok: false, reason: "stale", message: staleReadMessage(label, action) }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, reason: "missing", message: missingFileMessage(label, action) }
    }
    throw error
  }
}
