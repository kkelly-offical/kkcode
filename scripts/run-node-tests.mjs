import { readdir } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

const rootDir = process.cwd()
const testDir = path.join(rootDir, "test")

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectTests(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(fullPath)
    }
  }
  return files
}

const testFiles = (await collectTests(testDir)).sort()

if (testFiles.length === 0) {
  console.error("No test files found under test/")
  process.exit(1)
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit"
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
