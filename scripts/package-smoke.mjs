import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PACKAGE_VERSION } from "../src/version.mjs"
import { scanDirectoryTree } from "./secret-scan.mjs"

function run(command, args, cwd, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ""
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
    })
    if (capture) child.stdout.on("data", (chunk) => { stdout += chunk })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`))
    })
  })
}

const root = process.cwd()
const scratch = await mkdtemp(path.join(tmpdir(), "kkcode-package-smoke-"))
try {
  const packJson = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
    root,
    { capture: true }
  )
  const packed = JSON.parse(packJson)
  const tarball = path.join(scratch, packed[0].filename)
  await run("npm", ["init", "-y"], scratch)
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], scratch)
  const packageRoot = path.join(scratch, "node_modules", "@kkelly-offical", "kkcode")
  const payloadScan = scanDirectoryTree(packageRoot)
  if (payloadScan.findings.length > 0) {
    throw new Error(`packed payload secret scan failed:\n${payloadScan.findings.join("\n")}`)
  }
  console.log(`packed payload secret scan ok: ${payloadScan.scanned} files`)

  const entry = path.join(packageRoot, "src", "index.mjs")
  const version = await run(process.execPath, [entry, "--version"], scratch, { capture: true })
  if (version !== PACKAGE_VERSION) {
    throw new Error(`package smoke version mismatch: expected ${PACKAGE_VERSION}, got ${version}`)
  }
  console.log(`package smoke ok: ${version}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
