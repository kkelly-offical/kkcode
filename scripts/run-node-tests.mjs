import { readdir, mkdtemp, rm } from "node:fs/promises"
import os from 'node:os'
import path from "node:path"
import { spawn } from "node:child_process"

const rootDir = process.cwd()
const testDir = path.join(rootDir, "test")
const enableCoverage = process.argv.includes("--coverage")

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

const childArgs = enableCoverage
  ? [
      "--experimental-test-coverage",
      "--test-coverage-lines=60",
      "--test-coverage-functions=60",
      "--test-coverage-branches=60",
      "--test",
      ...testFiles
    ]
  : ["--test", ...testFiles]

const testHome = await mkdtemp(path.join(os.tmpdir(), 'kkcode-test-home-'))
const child = spawn(process.execPath, childArgs, {
  cwd: rootDir,
  env: { ...process.env, HOME: testHome, USERPROFILE: testHome, KKCODE_HOME: path.join(testHome, '.kkcode'), TERM: 'xterm-256color' },
  stdio: "inherit"
})

child.on("exit", async (code, signal) => {
  await rm(testHome, { recursive: true, force: true })
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
