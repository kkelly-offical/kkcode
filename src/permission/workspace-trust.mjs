import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { trustFilePath } from "../storage/paths.mjs"

async function readTrustFile(cwd) {
  try {
    return JSON.parse(await readFile(trustFilePath(cwd), "utf8"))
  } catch {
    return null
  }
}

export async function checkWorkspaceTrust({ cwd, cliTrust = false, isTTY = process.stdin.isTTY }) {
  if (cliTrust) {
    await persistTrust(cwd)
    return { trusted: true }
  }
  const data = await readTrustFile(cwd)
  if (data?.trusted === true) return { trusted: true }
  if (!isTTY) return { trusted: false }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => {
    rl.question("Do you trust this workspace? [y/N] ", (ans) => { rl.close(); resolve(ans) })
  })
  if (/^y(es)?$/i.test(String(answer).trim())) {
    await persistTrust(cwd)
    return { trusted: true }
  }
  return { trusted: false }
}

export async function persistTrust(cwd) {
  const file = trustFilePath(cwd)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ trusted: true, trustedAt: new Date().toISOString(), cwd }, null, 2), "utf8")
}

export async function revokeTrust(cwd) {
  const file = trustFilePath(cwd)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ trusted: false }, null, 2), "utf8")
}
