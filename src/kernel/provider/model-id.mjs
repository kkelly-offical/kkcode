import { ProviderError } from "../core/errors.mjs"

export const MAX_MODEL_ID_BYTES = 512

const TERMINAL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const TERMINAL_CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu

function escapedCodePoint(character) {
  const codePoint = character.codePointAt(0)
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).padStart(4, "0")}`
    : `\\u{${codePoint.toString(16)}}`
}

/**
 * Validate an opaque model identifier before it reaches provider routing,
 * persistent catalog caches, or terminal output.
 */
export function validateModelId(value, {
  label = "model id",
  allowEmpty = false,
  reason = "invalid_model"
} = {}) {
  const raw = String(value ?? "")
  const normalized = raw.trim()
  if (!normalized) {
    if (allowEmpty) return ""
    throw new ProviderError(`${label} must not be empty`, { reason })
  }
  if (TERMINAL_CONTROL_RE.test(raw)) {
    throw new ProviderError(`${label} contains terminal control characters`, { reason })
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_MODEL_ID_BYTES) {
    throw new ProviderError(`${label} exceeds ${MAX_MODEL_ID_BYTES} bytes`, { reason })
  }
  return normalized
}

/**
 * Rendering remains defensive even when data came from an older cache or a
 * caller that did not use validateModelId().
 */
export function escapeTerminalText(value) {
  return String(value ?? "").replace(TERMINAL_CONTROL_GLOBAL_RE, escapedCodePoint)
}
