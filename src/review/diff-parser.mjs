export function parseUnifiedDiff(diffText) {
  const lines = diffText.split(/\r?\n/)
  const files = []
  let current = null

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current)
      const parts = line.split(" ")
      const bPath = parts[3] || ""
      current = {
        path: bPath.replace(/^b\//, ""),
        added: 0,
        removed: 0,
        rawLines: [],
        addedLines: []
      }
      continue
    }
    if (!current) continue
    current.rawLines.push(line)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.added += 1
      current.addedLines.push(line.slice(1))
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.removed += 1
    }
  }
  if (current) files.push(current)
  return files.filter((file) => file.path.length > 0)
}

export function previewLines(file, limit = 80) {
  return file.rawLines.slice(0, limit)
}
