import { DOMParser } from "@xmldom/xmldom"

const OMIT = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed"])
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "figure", "figcaption", "ul", "ol", "dl", "dt", "dd", "table", "thead", "tbody"])

function safeLink(href, baseUrl) {
  if (!href) return null
  try {
    const url = new URL(href, baseUrl)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")
  } catch { return null }
}

function escapeText(value) {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]*_`<>])/g, "\\$1")
}

function codeFence(content, minimum) {
  let length = minimum
  for (const match of content.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  return "`".repeat(length)
}

/** Deterministic static HTML projection. No scripts, secondary requests, model
 * calls, browser cookies or hidden summarization. This is not a browser render. */
export function htmlToReadableMarkdown(html, baseUrl) {
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error("HTML exceeds the 2 MiB parsing limit; request a narrower page")
  if ((html.match(/</g) || []).length > 100000) throw new Error("HTML exceeds the document complexity limit")
  let document
  try { document = new DOMParser({ onError: () => {} }).parseFromString(html, "text/html") }
  catch { throw new Error("HTML could not be parsed; use Browser for this page") }
  const title = document.getElementsByTagName("title")[0]?.textContent?.trim() || ""
  // Prefer a semantic main/article; boilerplate-only pages fall back to body.
  const root = document.getElementsByTagName("main")[0] || document.getElementsByTagName("article")[0] || document.getElementsByTagName("body")[0] || document.documentElement
  let nodes = 0
  function visit(node, depth = 0, pre = false) {
    if (++nodes > 100000 || depth > 200) throw new Error("HTML exceeds the document complexity limit")
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = node.nodeValue || ""
      return pre ? text : escapeText(text.replace(/\s+/g, " "))
    }
    if (node.nodeType !== 1) return ""
    const tag = node.nodeName.toLowerCase()
    if (OMIT.has(tag) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return ""
    if (tag === "head") return ""
    const pieces = []
    for (let child = node.firstChild; child; child = child.nextSibling) pieces.push(visit(child, depth + 1, pre || tag === "pre" || tag === "code"))
    const content = pieces.join("")
    if (tag === "br") return "\n"
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`
    if (tag === "a") {
      const link = safeLink(node.getAttribute("href"), baseUrl)
      return link ? `[${content.trim() || link}](${link})` : content
    }
    if (tag === "img") {
      const alt = node.getAttribute("alt")?.trim()
      return alt ? `[Image: ${escapeText(alt)}]` : ""
    }
    if (tag === "pre") {
      const fence = codeFence(content, 3)
      return `\n\n${fence}\n${content.trim()}\n${fence}\n\n`
    }
    if (tag === "code" && !pre) {
      const fence = codeFence(content, 1)
      return `${fence} ${content.trim()} ${fence}`
    }
    if (tag === "strong" || tag === "b") return `**${content.trim()}**`
    if (tag === "em" || tag === "i") return `*${content.trim()}*`
    if (tag === "li") return `\n- ${content.trim()}\n`
    if (tag === "blockquote") return `\n\n${content.trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`
    if (tag === "td" || tag === "th") return `${content.trim()} | `
    if (tag === "tr") return `\n| ${content.trim()}\n`
    return BLOCK.has(tag) ? `\n\n${content.trim()}\n\n` : content
  }
  const markdown = visit(root).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return { title, markdown }
}

export async function readablePage(response, url) {
  const contentType = response.headers.get("content-type") || "text/plain"
  const mime = contentType.split(";")[0].trim().toLowerCase()
  if (!(mime.startsWith("text/") || /^(application\/(json|xml|xhtml\+xml|[^;]+\+json))$/.test(mime))) {
    throw new Error(`unsupported content type ${mime}; use an attachment or a format-specific tool`)
  }
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] || "utf-8"
  let decoder
  try { decoder = new TextDecoder(charset) } catch { throw new Error(`unsupported text charset ${charset}`) }
  const text = decoder.decode(await response.arrayBuffer())
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    const { title, markdown } = htmlToReadableMarkdown(text, url)
    return `Source: ${url}\n${title ? `Title: ${title.replace(/\s+/g, " ")}\n` : ""}\n${markdown || "No static readable content found. Use Browser for pages rendered by JavaScript."}`
  }
  return `Source: ${url}\n\n${text}`
}
