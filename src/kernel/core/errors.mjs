export class KkError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = "KkError"
    this.code = code
    this.details = details
  }
}

export class ValidationError extends KkError {
  constructor(message, details = null) {
    super("VALIDATION_ERROR", message, details)
    this.name = "ValidationError"
  }
}

export class ProviderError extends KkError {
  constructor(message, details = null) {
    super("PROVIDER_ERROR", message, details)
    this.name = "ProviderError"
  }
}

export class PermissionError extends KkError {
  constructor(message, details = null) {
    super("PERMISSION_DENIED", message, details)
    this.name = "PermissionError"
  }
}

export class ToolError extends KkError {
  constructor(message, details = null) {
    super("TOOL_ERROR", message, details)
    this.name = "ToolError"
  }
}

export class McpError extends KkError {
  /**
   * @param {string} message
   * @param {{ reason?: string, server?: string, action?: string } & Record<string, any>} [details]
   * reason: "timeout" | "spawn_failed" | "connection_refused" | "bad_response" | "server_crash" | "protocol_error" | "unknown"
   * （details 是透传给 KkError 的开放包：各 client 还会附 phase/code/tool/prompt 等定位字段。）
   */
  constructor(message, details = null) {
    super("MCP_ERROR", message, details)
    this.name = "McpError"
    this.reason = details?.reason || "unknown"
    this.server = details?.server || null
  }
}

export class SessionError extends KkError {
  constructor(message, details = null) {
    super("SESSION_ERROR", message, details)
    this.name = "SessionError"
  }
}
