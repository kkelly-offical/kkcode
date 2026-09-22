export async function runReplController({
  ctx,
  state,
  providersConfigured,
  customCommands,
  recentSessions,
  historyLines,
  mcpStatusLines = [],
  mcpHealth = null,
  startupUpdatePromise = null,
  startTuiRepl,
  startLineRepl,
  clearScreenFn,
  stdout = process.stdout,
  stdin = process.stdin,
  term = process.env.TERM,
  log = console.log
}) {
  if (stdout.isTTY && stdin.isTTY && term !== 'dumb') {
    await startTuiRepl({
      ctx,
      state,
      providersConfigured,
      customCommands,
      recentSessions,
      historyLines,
      mcpStatusLines,
      mcpHealth,
      startupUpdatePromise
    })
    return "tui"
  }

  clearScreenFn(stdout)
  for (const line of mcpStatusLines) log(line)
  await startLineRepl({
    ctx,
    state,
    providersConfigured,
    customCommands,
    recentSessions,
    historyLines
  })
  return "line"
}
