import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { trustFilePath } from "../../storage/paths.mjs"
import { writePrivateFile } from "../../storage/private-file.mjs"

async function readTrustFile(cwd) {
  try {
    const data = JSON.parse(await readFile(trustFilePath(cwd), "utf8"))
    if (!data || typeof data.trusted !== "boolean" || (data.recursive !== undefined && typeof data.recursive !== "boolean")) return { invalid: true }
    return data
  } catch (error) {
    return error.code === "ENOENT" ? null : { invalid: true }
  }
}

async function canonicalDirectory(cwd) {
  const resolved = await realpath(cwd)
  if (!(await stat(resolved)).isDirectory()) throw new Error("Workspace trust requires an existing directory")
  return resolved
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
  const askOrDeny = async () => {
    if (!isTTY || typeof prompt !== "function") return { trusted: false }
    const answer = await prompt("Do you trust this workspace? [y/N] ")
    if (/^y(es)?$/i.test(String(answer ?? "").trim())) {
      await persistTrust(cwd)
      return { trusted: true }
    }
    return { trusted: false }
  }
  // Physical identity is authoritative once present. A stale alias tombstone
  // (/var vs /private/var, Windows short names) must not override a later
  // explicit re-grant of that very directory. Legacy exact records remain a
  // fallback only where no canonical record exists.
  const canonical = await canonicalDirectory(cwd).catch(() => null)
  const data = (canonical ? await readTrustFile(canonical) : null) ?? await readTrustFile(cwd)
  if (data?.trusted === true) return { trusted: true }
  if (data?.trusted === false || data?.invalid) return askOrDeny()
  // Recursive grants live only in the OS user's private trust store. Existing
  // --trust records remain exact-directory grants. Resolve symlinks BEFORE
  // inheritance so a link out of an approved tree cannot widen that grant.
  if (canonical) {
    for (let parent = path.dirname(canonical); parent !== canonical;) {
      const inherited = await readTrustFile(parent)
      if (inherited?.invalid) return askOrDeny()
      if (inherited?.recursive === true) {
        if (typeof inherited.cwd !== "string" || path.resolve(inherited.cwd) !== parent) return askOrDeny()
        return inherited.trusted === true ? { trusted: true } : askOrDeny()
      }
      const next = path.dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  return askOrDeny()
}

/** @param {string} cwd @param {{ recursive?: boolean }} [options] */
export async function persistTrust(cwd, { recursive = false } = {}) {
  const target = recursive ? await canonicalDirectory(cwd) : await canonicalDirectory(cwd).catch(() => path.resolve(cwd))
  const prior = recursive ? null : await readTrustFile(target)
  // Reconfirming --trust at an already trusted tree root must not silently
  // narrow its grant. An exact re-grant after /untrust must NOT restore a
  // revoked recursive grant, however.
  const keepRecursive = prior?.trusted === true && prior.recursive === true && typeof prior.cwd === "string" && path.resolve(prior.cwd) === path.resolve(target)
  await writePrivateFile(trustFilePath(target), JSON.stringify({ trusted: true, trustedAt: new Date().toISOString(), cwd: target, ...((recursive || keepRecursive) ? { recursive: true } : {}) }, null, 2))
}

export async function revokeTrust(cwd) {
  const canonical = await canonicalDirectory(cwd).catch(() => path.resolve(cwd))
  const prior = await readTrustFile(canonical)
  const revoked = JSON.stringify({ trusted: false, ...(prior?.recursive === true ? { recursive: true, cwd: canonical } : {}) }, null, 2)
  await writePrivateFile(trustFilePath(canonical), revoked)
  if (canonical !== path.resolve(cwd)) await writePrivateFile(trustFilePath(cwd), JSON.stringify({ trusted: false }))
}
