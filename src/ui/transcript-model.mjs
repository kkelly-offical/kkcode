const DEFAULT_MAX_ITEMS = 2000

function finiteTime(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function stringLines(value) {
  if (Array.isArray(value)) {
    return value.flatMap((line) => String(line ?? "").split(/\r?\n/))
  }
  if (value === null || value === undefined) return []
  return String(value).split(/\r?\n/)
}

function cloneItem(item) {
  return {
    ...item,
    details: [...item.details],
    metadata: item.metadata && typeof item.metadata === "object"
      ? { ...item.metadata }
      : item.metadata
  }
}

export function normalizeTranscriptItem(input, {
  id,
  timestamp = Date.now()
} = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : { summary: input }
  const details = stringLines(source.details)
  const summary = source.summary ?? source.title ?? source.text ?? ""
  const createdAt = finiteTime(source.createdAt, timestamp)
  const collapsible = source.collapsible === undefined
    ? details.length > 0
    : Boolean(source.collapsible)

  return {
    id: String(source.id || id || ""),
    kind: String(source.kind || "text"),
    summary: String(summary ?? ""),
    details,
    collapsible,
    expanded: collapsible ? Boolean(source.expanded) : false,
    status: String(source.status || "complete"),
    tone: String(source.tone || "default"),
    createdAt,
    updatedAt: finiteTime(source.updatedAt, createdAt),
    metadata: source.metadata && typeof source.metadata === "object"
      ? { ...source.metadata }
      : {}
  }
}

function chevronFor(item) {
  if (!item.collapsible || item.details.length === 0) return ""
  return item.expanded ? "▾ " : "▸ "
}

function renderItem(item, { paint, theme } = {}) {
  const colorize = typeof paint === "function" ? paint : (text) => text
  const muted = theme?.base?.muted || "#8a8a8a"
  const summaryLines = stringLines(item.summary)
  if (summaryLines.length === 0) summaryLines.push("")
  const clickable = item.collapsible && item.details.length > 0
  const rendered = []

  // 按说话人上色（0.6.0）。item.kind 一直是一等字段，渲染时却完全不消费 ——
  // 用户输入与模型回复在屏幕上除了前缀毫无区别。markdown 已着色的正文不再
  // 二次上色（否则 SGR 嵌套会把内层颜色截断）。
  //
  // 提示性内容（kind:"system"）与对话气泡的区分（1.0.1）：固定的弱化 gutter
  // 「· 」+ tone 驱动的语义色；不带语气的纯提示整体 dim —— 扫一眼就知道
  // 哪行是「系统在说」，哪行是「对话内容」。
  const roles = theme?.roles || {}
  const toneColors = {
    error: theme?.semantic?.error,
    warn: theme?.semantic?.warn,
    warning: theme?.semantic?.warn,
    success: theme?.semantic?.success,
    info: theme?.semantic?.info,
    muted
  }
  const isSystem = item.kind === "system"
  const toneTint = toneColors[item.tone] || null
  const roleColor = item.kind === "user" ? roles.user
    : item.kind === "assistant" ? roles.assistant
    : isSystem ? (toneTint || roles.system)
    : null
  const dimBody = isSystem && !toneTint

  for (let index = 0; index < summaryLines.length; index++) {
    const chevron = chevronFor(item)
    // 无箭头也无 gutter 的行前缀就是空串：给它包一层 paint 只会产出一条
    // 看不见的 ANSI 空壳，白白喂给每一帧的差分绘制
    const prefix = index === 0
      ? (chevron ? colorize(chevron, muted, { dim: true }) : isSystem ? colorize("· ", muted, { dim: true }) : "")
      : "  "
    const body = roleColor && !summaryLines[index].includes("\u001b[")
      ? colorize(summaryLines[index], roleColor, dimBody ? { dim: true } : {})
      : summaryLines[index]
    rendered.push({
      text: `${prefix}${body}`,
      itemId: item.id,
      kind: item.kind,
      section: "summary",
      clickable,
      action: clickable ? "toggle" : null,
      wrappedIndex: 0
    })
  }

  if (clickable && item.expanded) {
    for (const detail of item.details) {
      rendered.push({
        text: detail,
        itemId: item.id,
        kind: item.kind,
        section: "detail",
        clickable: true,
        action: "toggle",
        wrappedIndex: 0
      })
    }
  }

  return rendered
}

/**
 * Flatten transcript items into renderable lines while retaining the item
 * identity needed by mouse and keyboard hit testing.
 */
export function renderTranscriptItems(items = [], options = {}) {
  const lines = []
  for (const source of items) {
    const item = source?.summary !== undefined
      || source?.details !== undefined
      || source?.title !== undefined
      ? normalizeTranscriptItem(source, { id: source?.id })
      : normalizeTranscriptItem(source, { id: source?.id || "" })
    lines.push(...renderItem(item, options))
  }
  return lines
}

/**
 * Small state container used by the REPL and activity renderer. appendLog and
 * updateLog deliberately match the output adapter consumed by
 * createActivityRenderer, while strings remain valid for legacy callers.
 */
export function createTranscriptModel({
  maxItems = DEFAULT_MAX_ITEMS,
  now = () => Date.now()
} = {}) {
  const limit = Math.max(1, Number(maxItems) || DEFAULT_MAX_ITEMS)
  const listeners = new Set()
  const items = []
  let sequence = 0

  function nextId() {
    sequence += 1
    return `transcript_${sequence}`
  }

  function notify(type, item = null) {
    const event = {
      type,
      item: item ? cloneItem(item) : null,
      items: items.map(cloneItem)
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Rendering observers must not break transcript state updates.
      }
    }
  }

  function appendLog(input, options = {}) {
    const timestamp = now()
    const source = input && typeof input === "object" && !Array.isArray(input)
      ? { ...input, ...options }
      : { ...options, summary: input }
    const item = normalizeTranscriptItem(source, {
      id: source.id || nextId(),
      timestamp
    })
    if (!item.id) item.id = nextId()
    items.push(item)
    if (items.length > limit) items.splice(0, items.length - limit)
    notify("append", item)
    return item.id
  }

  function updateLog(id, patch) {
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return null
    const current = items[index]
    const changes = typeof patch === "function"
      ? patch(cloneItem(current))
      : patch
    if (!changes || typeof changes !== "object") return cloneItem(current)

    const timestamp = now()
    const normalized = normalizeTranscriptItem({
      ...current,
      ...changes,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      details: changes.details === undefined ? current.details : changes.details,
      metadata: changes.metadata === undefined
        ? current.metadata
        : { ...current.metadata, ...changes.metadata }
    }, {
      id: current.id,
      timestamp
    })
    items[index] = normalized
    notify("update", normalized)
    return cloneItem(normalized)
  }

  function toggleLog(id, expanded) {
    const current = items.find((item) => item.id === id)
    if (!current || !current.collapsible || current.details.length === 0) return null
    return updateLog(id, {
      expanded: expanded === undefined ? !current.expanded : Boolean(expanded)
    })
  }

  function removeLog(id) {
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return false
    const [removed] = items.splice(index, 1)
    notify("remove", removed)
    return true
  }

  function clear() {
    if (items.length === 0) return
    items.length = 0
    notify("clear")
  }

  return {
    append: appendLog,
    appendLog,
    update: updateLog,
    updateLog,
    toggle: toggleLog,
    toggleLog,
    remove: removeLog,
    removeLog,
    clear,
    getItems() {
      return items.map(cloneItem)
    },
    getItem(id) {
      const item = items.find((candidate) => candidate.id === id)
      return item ? cloneItem(item) : null
    },
    render(options = {}) {
      return renderTranscriptItems(items, options)
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
