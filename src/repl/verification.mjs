export function buildReplSmokeChecklist() {
  return [
    "start repl in tty mode",
    "verify /help and /status output",
    "verify slash suggestion and selection flow",
    "submit one normal prompt turn",
    "exercise one permission or question dialog",
    "inspect background/task visibility",
    "confirm --help and --version CLI outputs"
  ]
}

export function summarizeVerificationResults(results = []) {
  const total = results.length
  const passed = results.filter((item) => item?.ok === true).length
  const failed = total - passed
  return {
    total,
    passed,
    failed,
    ok: failed === 0
  }
}
