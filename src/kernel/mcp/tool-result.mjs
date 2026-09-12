import { McpError } from "../core/errors.mjs"

export function normalizeToolResult(result, serverName, toolName) {
  if (result?.isError) {
    const text = Array.isArray(result.content)
      ? result.content.map((item) => item?.text || "").join("\n").trim()
      : ""
    throw new McpError(text || "mcp tool returned isError", {
      reason: "bad_response",
      server: serverName,
      action: `tools/call:${toolName}`,
      phase: "request"
    })
  }
  const content = Array.isArray(result?.content) ? result.content : null
  const contentText = content
    ? content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n").trim()
    : ""
  const output =
    contentText ||
    (typeof result?.output === "string" ? result.output : "") ||
    (typeof result === "string" ? result : JSON.stringify(result))
  return content ? { output, raw: result, content } : { output, raw: result }
}
