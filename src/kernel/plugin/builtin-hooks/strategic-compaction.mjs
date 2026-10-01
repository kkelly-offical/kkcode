// Retain this built-in hook name for compatibility, not its old heuristic.
// The session loop owns complete-input metering and automatic compaction;
// CLI/Web/Android render that session's context meter. A module-global call
// counter was neither token pressure nor session-local progress, and appending
// its advice changed actual tool bytes (including structured/JSON output).

export default {
  name: "strategic-compaction",
  tool: {
    async after(payload) {
      return payload
    }
  }
}
