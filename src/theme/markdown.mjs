import { paint } from "./color.mjs"

const COLORS = {
  code: "cyan",
  codeBlock: "#a9b7c6",
  codeFence: "#555555",
  heading: "white",
  quote: "#8da3b9",
  listMarker: "#8a8a8a"
}

function renderLine(line) {
  const headingMatch = line.match(/^(#{1,6})\s+(.*)/)
  if (headingMatch) {
    const level = headingMatch[1].length
    const content = headingMatch[2]
    const indent = level > 1 ? "  ".repeat(level - 1) : ""
    return `${indent}${paint(renderInline(content), COLORS.heading, { bold: level <= 2 })}`
  }

  if (line.trimStart().startsWith("> ")) {
    const content = line.replace(/^\s*>\s?/, "")
    return paint(`\u2502 ${renderInline(content)}`, COLORS.quote)
  }

  const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)/)
  if (ulMatch) {
    return `${ulMatch[1]}${paint("\u2022", COLORS.listMarker)} ${renderInline(ulMatch[3])}`
  }

  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/)
  if (olMatch) {
    return `${olMatch[1]}${paint(`${olMatch[2]}.`, COLORS.listMarker)} ${renderInline(olMatch[3])}`
  }

  return renderInline(line)
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => paint(code, COLORS.code))
    .replace(/\*\*([^*]+)\*\*/g, (_, b) => paint(b, null, { bold: true }))
    .replace(/__([^_]+)__/g, (_, b) => paint(b, null, { bold: true }))
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, i) => paint(i, null, { dim: true }))
    .replace(/(?<!_)_([^_]+)_(?!_)/g, (_, i) => paint(i, null, { dim: true }))
}

export function renderMarkdown(text) {
  if (!text) return ""
  const lines = text.split("\n")
  const out = []
  let inCodeBlock = false
  let codeLang = ""

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        codeLang = line.trimStart().slice(3).trim()
        const label = codeLang ? ` ${codeLang} ` : ""
        out.push(paint(`\u2500\u2500\u2500${label}${"".padEnd(Math.max(0, 40 - label.length), "\u2500")}`, COLORS.codeFence))
        inCodeBlock = true
      } else {
        out.push(paint("\u2500".repeat(43), COLORS.codeFence))
        inCodeBlock = false
        codeLang = ""
      }
      continue
    }

    if (inCodeBlock) {
      out.push(paint(`  ${line}`, COLORS.codeBlock))
      continue
    }

    out.push(renderLine(line))
  }
  return out.join("\n")
}

export function createStreamRenderer() {
  let buffer = ""
  let inCodeBlock = false

  function push(chunk) {
    buffer += chunk
    const output = []

    while (true) {
      const idx = buffer.indexOf("\n")
      if (idx === -1) break

      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)

      if (line.trimStart().startsWith("```")) {
        if (!inCodeBlock) {
          const lang = line.trimStart().slice(3).trim()
          const label = lang ? ` ${lang} ` : ""
          output.push(paint(`\u2500\u2500\u2500${label}${"".padEnd(Math.max(0, 40 - label.length), "\u2500")}`, COLORS.codeFence) + "\n")
          inCodeBlock = true
        } else {
          output.push(paint("\u2500".repeat(43), COLORS.codeFence) + "\n")
          inCodeBlock = false
        }
        continue
      }

      if (inCodeBlock) {
        output.push(paint(`  ${line}`, COLORS.codeBlock) + "\n")
      } else {
        output.push(renderLine(line) + "\n")
      }
    }

    if (!inCodeBlock && buffer.length > 0 && !buffer.startsWith("```")) {
      const partial = renderInline(buffer)
      buffer = ""
      output.push(partial)
    }

    return output.join("")
  }

  function flush() {
    if (!buffer) return ""
    const remaining = inCodeBlock
      ? paint(`  ${buffer}`, COLORS.codeBlock)
      : renderLine(buffer)
    buffer = ""
    inCodeBlock = false
    return remaining
  }

  return { push, flush }
}
