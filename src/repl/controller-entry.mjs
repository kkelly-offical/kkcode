export async function runReplController({
  ctx,
  state,
  providersConfigured,
  customCommands,
  recentSessions,
  historyLines,
  mcpStatusLines = [],
  startTuiRepl,
  startLineRepl,
  clearScreenFn,
  stdout = process.stdout,
  stdin = process.stdin,
  log = console.log
}) {
  if (stdout.isTTY && stdin.isTTY) {
    await startTuiRepl({
      ctx,
      state,
      providersConfigured,
      customCommands,
      recentSessions,
      historyLines,
      mcpStatusLines
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
