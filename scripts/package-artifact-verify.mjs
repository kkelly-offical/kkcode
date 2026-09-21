import { createHash } from "node:crypto"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.mjs"
import { scanDirectoryTree } from "./secret-scan.mjs"
import { verificationCommand } from './verification-command.mjs'

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const invocation = verificationCommand(command, args)
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: invocation.shell,
      stdio: "inherit"
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`))
    })
  })
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

const rawTarball = String(process.env.KKCODE_PACKAGE_TARBALL || "").trim()
if (!rawTarball) throw new Error("KKCODE_PACKAGE_TARBALL is required")
const tarball = path.resolve(rawTarball)
const digestBefore = await sha256(tarball)
const scratch = await mkdtemp(path.join(tmpdir(), "kkcode-package-artifact-"))

try {
  // No packaged entrypoint is executed after the final tarball is created.
  // npm only unpacks it, with every lifecycle script disabled.
  await run("npm", ["init", "-y"], scratch)
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], scratch)

  const packageRoot = path.join(scratch, "node_modules", "@kkelly-offical", "kkcode")
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
  if (metadata.name !== PACKAGE_NAME || metadata.version !== PACKAGE_VERSION) {
    throw new Error(
      `package artifact metadata mismatch: expected ${PACKAGE_NAME}@${PACKAGE_VERSION}, ` +
      `got ${metadata.name || "unknown"}@${metadata.version || "unknown"}`
    )
  }

  const payloadScan = scanDirectoryTree(packageRoot)
  if (payloadScan.findings.length > 0) {
    throw new Error(`packed payload secret scan failed:\n${payloadScan.findings.join("\n")}`)
  }
  const digestAfter = await sha256(tarball)
  if (digestAfter !== digestBefore) {
    throw new Error("package artifact changed while it was being verified")
  }
  console.log(`immutable package verified: ${PACKAGE_VERSION}, ${payloadScan.scanned} files, sha256 ${digestAfter}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
