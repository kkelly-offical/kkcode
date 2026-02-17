// Strategic compaction suggestion hook
// Suggests /compact at logical breakpoints instead of waiting for automatic compaction

let toolCallCount = 0
let lastSuggestionAt = 0
const THRESHOLD = 30 // suggest every ~30 tool calls

export default {
  name: "strategic-compaction",
  tool: {
    async after(payload) {
      toolCallCount++

      // Only suggest periodically
      if (toolCallCount - lastSuggestionAt < THRESHOLD) return payload

      const { toolName, result } = payload

      // Detect logical breakpoints: after research phases, after build/test, after multi-file edits
      const isResearchEnd = toolName === "grep" || toolName === "glob" || toolName === "read"
      const isBuildEnd = toolName === "bash"
      const isEditEnd = toolName === "edit" || toolName === "write" || toolName === "multiedit"

      if (!isResearchEnd && !isBuildEnd && !isEditEnd) return payload

      lastSuggestionAt = toolCallCount
      const suggestion = `\n💡 You've made ${toolCallCount} tool calls in this session. Consider running /compact to free up context space if the conversation is getting long.`

      if (typeof result === "string") {
        payload.result = result + suggestion
      } else if (result && typeof result === "object") {
        payload.result = { ...result, output: (result.output || "") + suggestion }
      }

      return payload
    }
  }
}
