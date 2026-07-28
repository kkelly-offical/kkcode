import { StringDecoder } from "node:string_decoder"

const COMPLETE_SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
// stdin chunks may end immediately after ESC, before the rest of an SGR
// report arrives. Keep the ambiguous byte until the caller explicitly flushes
// it (normally after a short escape-key timeout).
const POSSIBLE_MOUSE_SUFFIX_RE = /\x1b(?:\[|\[<[\d;]*)?$/
const BRACKETED_PASTE_START = "\x1b[200~"
const BRACKETED_PASTE_END = "\x1b[201~"
// DECSET 1004 焦点上报：获得焦点 ESC [ I，失去焦点 ESC [ O。
const FOCUS_EVENT_RE = /\x1b\[([IO])/g
// 与鼠标上报同理：chunk 可能正好断在 ESC 或 ESC [ 之后，尾部的歧义字节要留到下一次。
const POSSIBLE_FOCUS_SUFFIX_RE = /\x1b\[?$/
// OSC 11 背景色查询的响应：ESC ] 11 ; rgb:RRRR/GGGG/BBBB，BEL 或 ST(ESC \) 结尾。
// 只认 11 —— 别的 OSC（比如我们自己发的标题 OSC 2）不该被这里吃掉。
const OSC11_RESPONSE_RE = /\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// 可能是响应开头的尾巴：从 ESC 到 "\x1b]11;" 的任意前缀，扣住等下一个 chunk
const POSSIBLE_OSC11_SUFFIX_RE = /\x1b(?:\](?:1(?:1;?[^\x07\x1b]*)?)?)?$/

export function createUtf8TextDecoder() {
  let decoder = new StringDecoder("utf8")

  return {
    feed(value) {
      if (Buffer.isBuffer(value)) return decoder.write(value)
      const buffered = decoder.end()
      decoder = new StringDecoder("utf8")
      return buffered + String(value || "")
    },

    flush() {
      const text = decoder.end()
      decoder = new StringDecoder("utf8")
      return text
    },

    reset() {
      decoder.end()
      decoder = new StringDecoder("utf8")
    }
  }
}

/**
 * Incrementally decodes SGR mouse reports without sharing RegExp.lastIndex
 * between detection and parsing. Terminals and multiplexers may split an
 * escape sequence across arbitrary stdin chunks, so incomplete suffixes are
 * retained until the next feed.
 */
export function createSgrMouseDecoder() {
  let pending = ""
  const utf8 = createUtf8TextDecoder()

  return {
    feed(chunk) {
      let source = pending + utf8.feed(chunk)
      pending = ""
      const events = []

      source = source.replace(COMPLETE_SGR_MOUSE_RE, (_match, button, x, y, suffix) => {
        const code = Number(button)
        events.push({
          button: code & 0b11,
          code,
          x: Number(x),
          y: Number(y),
          release: suffix === "m",
          motion: Boolean(code & 32),
          wheel: code & 64 ? (code & 1 ? "down" : "up") : null,
          shift: Boolean(code & 4),
          alt: Boolean(code & 8),
          ctrl: Boolean(code & 16)
        })
        return ""
      })
      COMPLETE_SGR_MOUSE_RE.lastIndex = 0

      const suffix = source.match(POSSIBLE_MOUSE_SUFFIX_RE)
      if (suffix && suffix.index !== undefined && suffix[0]) {
        pending = suffix[0]
        source = source.slice(0, suffix.index)
      }

      return { events, text: source }
    },

    hasPending() {
      return pending.length > 0
    },

    flush() {
      const text = pending + utf8.flush()
      pending = ""
      return text
    },

    reset() {
      pending = ""
      utf8.reset()
    }
  }
}

/**
 * 摘出终端的焦点上报（DECSET 1004）。
 *
 * 必须和鼠标、括号粘贴在**同一层**被吃掉：`ESC [ I` 只要漏进 readline，`I` 就会
 * 变成一个字符插进输入框 —— 用户切回窗口，输入框里多了个字母。
 *
 * 形状与 `createSgrMouseDecoder` 完全一致（feed → {text, events}、hasPending、
 * flush、reset），所以它能直接串进 `dispatchDecodedInput` 那条链：
 * 鼠标 → 焦点 → 括号粘贴。放在粘贴之前，是为了让焦点上报不会掉进粘贴载荷里
 * （鼠标上报同理，这条链本来就是这个顺序）。
 */
/**
 * 摘出 OSC 11（终端背景色查询）的响应。
 *
 * 我们在 TUI 启动时发一次 `ESC ] 11 ; ? BEL`，支持的终端会把背景色作为同格式
 * 的序列**从 stdin** 送回来 —— 不摘掉的话它会漏进 readline，用户输入框里凭空
 * 多出一串 `rgb:1e1e/1e1e/1e1e`。形状与 createFocusDecoder 完全一致（feed →
 * {text, responses}、hasPending、flush、reset），串进解码链的同一层。
 *
 * 不支持查询的终端**根本不回**（这就是探测要带超时的原因），所以这层在绝大多
 * 数字节上是纯透传；扣字节只发生在文本尾部恰好像响应前缀时（`ESC ]`、`ESC ]1`…），
 * 由转义超时的 flush 兜底放出 —— 与焦点解码器同一套安全网。
 */
export function createOsc11Decoder() {
  let pending = ""

  return {
    feed(text) {
      let source = pending + text
      pending = ""
      const responses = []

      source = source.replace(OSC11_RESPONSE_RE, (_match, payload) => {
        responses.push(payload)
        return ""
      })
      OSC11_RESPONSE_RE.lastIndex = 0

      const suffix = source.match(POSSIBLE_OSC11_SUFFIX_RE)
      if (suffix && suffix.index !== undefined && suffix[0]) {
        pending = suffix[0]
        source = source.slice(0, suffix.index)
      }

      return { responses, text: source }
    },

    hasPending() {
      return pending.length > 0
    },

    flush() {
      const text = pending
      pending = ""
      return text
    },

    reset() {
      pending = ""
    }
  }
}

export function createFocusDecoder() {
  let pending = ""
  const utf8 = createUtf8TextDecoder()

  return {
    feed(chunk) {
      let source = pending + utf8.feed(chunk)
      pending = ""
      const events = []

      source = source.replace(FOCUS_EVENT_RE, (_match, letter) => {
        events.push({ focused: letter === "I" })
        return ""
      })
      FOCUS_EVENT_RE.lastIndex = 0

      const suffix = source.match(POSSIBLE_FOCUS_SUFFIX_RE)
      if (suffix && suffix.index !== undefined && suffix[0]) {
        pending = suffix[0]
        source = source.slice(0, suffix.index)
      }

      return { events, text: source }
    },

    hasPending() {
      return pending.length > 0
    },

    flush() {
      const text = pending + utf8.flush()
      pending = ""
      return text
    },

    reset() {
      pending = ""
      utf8.reset()
    }
  }
}

function trailingPrefixLength(text, marker, minLength = 1) {
  const max = Math.min(text.length, marker.length - 1)
  for (let length = max; length >= minLength; length--) {
    if (marker.startsWith(text.slice(-length))) return length
  }
  return 0
}

/**
 * Separates bracketed paste payloads from ordinary keyboard bytes. Multiline
 * paste is returned as one value so embedded newlines cannot accidentally
 * submit several prompts.
 */
export function createBracketedPasteDecoder() {
  let pending = ""
  let paste = ""
  let inPaste = false
  const utf8 = createUtf8TextDecoder()

  return {
    feed(chunk) {
      let source = pending + utf8.feed(chunk)
      pending = ""
      let text = ""
      const pastes = []

      while (source) {
        if (!inPaste) {
          const start = source.indexOf(BRACKETED_PASTE_START)
          if (start >= 0) {
            text += source.slice(0, start)
            source = source.slice(start + BRACKETED_PASTE_START.length)
            inPaste = true
            paste = ""
            continue
          }
          const held = trailingPrefixLength(source, BRACKETED_PASTE_START)
          text += held ? source.slice(0, -held) : source
          pending = held ? source.slice(-held) : ""
          source = ""
          continue
        }

        const end = source.indexOf(BRACKETED_PASTE_END)
        if (end >= 0) {
          paste += source.slice(0, end)
          pastes.push(paste)
          source = source.slice(end + BRACKETED_PASTE_END.length)
          paste = ""
          inPaste = false
          continue
        }
        const held = trailingPrefixLength(source, BRACKETED_PASTE_END)
        paste += held ? source.slice(0, -held) : source
        pending = held ? source.slice(-held) : ""
        source = ""
      }

      return { text, pastes, inPaste }
    },

    hasPending() {
      return pending.length > 0
    },

    flush() {
      const buffered = pending + utf8.flush()
      pending = ""
      if (inPaste) {
        paste += buffered
        return { text: "", pastes: [], inPaste }
      }
      return { text: buffered, pastes: [], inPaste }
    },

    reset() {
      pending = ""
      paste = ""
      inPaste = false
      utf8.reset()
    }
  }
}

export function isScreenRowWithin(row, startRow, endRow) {
  const current = Number(row)
  const start = Number(startRow)
  const end = Number(endRow)
  return Number.isFinite(current) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    current >= start &&
    current <= end
}

export function resolveTerminalFeatures(config = {}, env = process.env) {
  const capable = env.TERM !== "dumb"
  const resolveMode = (value, fallback) => {
    if (value === true || value === "always") return true
    if (value === false || value === "never") return false
    return fallback
  }
  return {
    alternateScreen: resolveMode(config.alternate_screen, capable),
    mouse: resolveMode(config.mouse, capable),
    bracketedPaste: config.bracketed_paste !== false,
    copyOnSelect: config.copy_on_select !== false,
    // 开着它才有人喂通知模块的 setFocused。这一位同时管两件事：要不要发 1004h，
    // 以及要不要在输入链上串焦点解码器 —— 只做一半的话，`ESC [ I` 会漏进输入框。
    focusReporting: resolveMode(config.focus_reporting, capable)
  }
}

export function classifySgrMouseEvent(event = {}) {
  if (event.wheel === "up") return "wheel-up"
  if (event.wheel === "down") return "wheel-down"
  if (event.button === 0 && event.motion) return "primary-drag"
  if (event.button === 0 && event.release) return "primary-release"
  if (event.button === 0) return "primary-press"
  if (event.button === 2 && !event.release) return "secondary-press"
  return "other"
}

/**
 * Convert inclusive 1-based terminal pointer cells into an exclusive
 * zero-based range. Tracking `moved` distinguishes a true click (used to
 * toggle a block) from a drag that returns to its starting cell.
 */
export function normalizeMouseSelection(selection = {}) {
  let startRow = Math.max(0, Number(selection.startRow || 1) - 1)
  let startCol = Math.max(0, Number(selection.startCol || 1) - 1)
  let endRow = Math.max(0, Number(selection.endRow || 1) - 1)
  let endCol = Math.max(0, Number(selection.endCol || 1) - 1)
  const isClick = !selection.moved && startRow === endRow && startCol === endCol

  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    ;[startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol]
  }

  return {
    startRow,
    startCol,
    endRow,
    endCol: isClick ? endCol : endCol + 1,
    isClick
  }
}

export function enterTerminalSequence(features = {}) {
  let sequence = ""
  if (features.alternateScreen !== false) sequence += "\x1b[?1049h"
  if (features.bracketedPaste !== false) sequence += "\x1b[?2004h"
  if (features.focusReporting !== false) sequence += "\x1b[?1004h"
  if (features.mouse !== false) sequence += "\x1b[?1002h\x1b[?1006h"
  return sequence
}

export function exitTerminalSequence(features = {}) {
  let sequence = ""
  if (features.mouse !== false) sequence += "\x1b[?1002l\x1b[?1006l"
  // 关掉 1004 比关掉鼠标更要紧：留着它，用户回到 shell 之后每次切窗口都会
  // 收到一串 `^[[I` —— 而 shell 不认识它。
  if (features.focusReporting !== false) sequence += "\x1b[?1004l"
  if (features.bracketedPaste !== false) sequence += "\x1b[?2004l"
  sequence += "\x1b[?7h\x1b[?25h\x1b[0m"
  if (features.alternateScreen !== false) {
    sequence += "\x1b[?1049l"
  } else {
    // Leave the shell on a fresh line below the normal-screen UI.
    sequence += "\x1b[999;1H\x1b[2K\r\n"
  }
  return sequence
}

function clampInteger(value, min, max) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min
  return Math.max(min, Math.min(max, number))
}

/**
 * Produces a row-addressed frame patch. Every changed row is cleared and
 * painted independently while autowrap is disabled, then the hardware cursor
 * is restored to the input location for IME and accessibility support.
 */
export function renderTerminalFrame({
  lines = [],
  previousLines = [],
  width = 80,
  height = lines.length || 1,
  cursor = null,
  force = false
} = {}) {
  const rowCount = Math.max(1, Math.trunc(height || 1))
  const columnCount = Math.max(1, Math.trunc(width || 1))
  const output = ["\x1b[?25l\x1b[?7l"]
  if (force) output.push("\x1b[2J")

  const maxRows = Math.min(rowCount, Math.max(lines.length, previousLines.length))
  for (let index = 0; index < maxRows; index++) {
    const next = String(lines[index] || "")
    if (!force && next === String(previousLines[index] || "")) continue
    output.push(`\x1b[${index + 1};1H\x1b[2K${next}\x1b[0m`)
  }

  output.push("\x1b[?7h")
  if (cursor?.visible !== false) {
    const row = clampInteger(cursor?.row, 1, rowCount)
    const col = clampInteger(cursor?.col, 1, columnCount)
    output.push(`\x1b[${row};${col}H\x1b[?25h`)
  }

  return output.join("")
}
