import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { trustFilePath } from "../../storage/paths.mjs"

async function readTrustFile(cwd) {
  try {
    return JSON.parse(await readFile(trustFilePath(cwd), "utf8"))
  } catch {
    return null
  }
}

/**
 * 工作区信任探测（1.0.0 阶段 3b，M3 耦合点 15）：本函数不再自开终端行
 * 读取。TTY 下的交互询问由前端注入 `prompt`（REPL 启动时传入自己的行式
 * 提问实现）；未注入 prompt 的宿主（headless/CI/管道输入）得到确定性
 * untrusted —— 显式授信走 --trust / /trust。
 */
export async function checkWorkspaceTrust({ cwd, cliTrust = false, isTTY = process.stdin.isTTY, prompt = null }) {
  if (cliTrust) {
    await persistTrust(cwd)
    return { trusted: true }
  }
  const data = await readTrustFile(cwd)
  if (data?.trusted === true) return { trusted: true }
  if (!isTTY || typeof prompt !== "function") return { trusted: false }

  const answer = await prompt("Do you trust this workspace? [y/N] ")
  if (/^y(es)?$/i.test(String(answer ?? "").trim())) {
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
