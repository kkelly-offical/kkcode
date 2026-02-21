import { readFile, writeFile, unlink, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { githubTokenPath } from "../storage/paths.mjs"

const CLIENT_ID = "Ov23liCqhJ6cRaqyv3uA"
const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
const SCOPE = "repo"

export async function getStoredToken() {
  try {
    const raw = await readFile(githubTokenPath(), "utf8")
    const data = JSON.parse(raw)
    if (data.token && data.login) return data
    return null
  } catch {
    return null
  }
}

async function saveToken(data) {
  const filePath = githubTokenPath()
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function logout() {
  try {
    await unlink(githubTokenPath())
    return true
  } catch {
    return false
  }
}

async function validateToken(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    })
    if (res.ok) {
      const user = await res.json()
      return { valid: true, login: user.login }
    }
    return { valid: false, login: null }
  } catch {
    return { valid: false, login: null }
  }
}

async function requestDeviceCode() {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE })
  })
  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status}`)
  }
  return res.json()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 跨平台打开浏览器
 * @param {string} url - 要打开的 URL
 */
function openBrowser(url) {
  const platform = process.platform
  let command
  let args

  if (platform === "win32") {
    // Windows
    command = "cmd"
    args = ["/c", "start", "", url]
  } else if (platform === "darwin") {
    // macOS
    command = "open"
    args = [url]
  } else {
    // Linux 和其他平台
    command = "xdg-open"
    args = [url]
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * 跨平台复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {boolean} 是否成功
 */
function copyToClipboard(text) {
  const platform = process.platform
  let command
  let args
  let input = text

  if (platform === "win32") {
    // Windows - 使用 clip 命令
    command = "clip"
    args = []
  } else if (platform === "darwin") {
    // macOS - 使用 pbcopy
    command = "pbcopy"
    args = []
  } else {
    // Linux - 尝试 wl-copy (Wayland) 或 xclip (X11)
    try {
      // 先尝试 wl-copy (Wayland)
      const child = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] })
      child.stdin.write(text)
      child.stdin.end()
      return true
    } catch {
      // 回退到 xclip (X11)
      try {
        const child = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] })
        child.stdin.write(text)
        child.stdin.end()
        return true
      } catch {
        return false
      }
    }
  }

  try {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] })
    child.stdin.write(input)
    child.stdin.end()
    return true
  } catch {
    return false
  }
}

async function pollAccessToken(deviceCode, interval) {
  let retryCount = 0
  const maxRetries = 3

  while (true) {
    await sleep(interval * 1000)

    let res
    try {
      res = await fetch(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        })
      })
      retryCount = 0 // 重置重试计数
    } catch (networkError) {
      retryCount++
      if (retryCount >= maxRetries) {
        throw new Error(`Network error after ${maxRetries} retries: ${networkError.message}`)
      }
      process.stdout.write(`\n  \x1b[33m⚠ 网络错误，${maxRetries - retryCount} 秒后重试...\x1b[0m`)
      await sleep(1000)
      process.stdout.write("\r  \x1b[K等待授权...")
      continue
    }

    let data
    try {
      data = await res.json()
    } catch {
      // 如果无法解析 JSON，可能是网络问题，继续等待
      continue
    }

    if (data.access_token) {
      return data.access_token
    }
    if (data.error === "authorization_pending") {
      process.stdout.write(".")
      continue
    }
    if (data.error === "slow_down") {
      interval = (data.interval || interval) + 1
      process.stdout.write("\n  \x1b[33m⚠ 请求过于频繁，已放慢速度...\x1b[0m")
      continue
    }
    if (data.error === "expired_token") {
      throw new Error("Authorization timed out. Please try again.")
    }
    if (data.error === "access_denied") {
      throw new Error("Authorization denied by user.")
    }
    // 其他错误，记录但继续等待（可能是临时错误）
    process.stdout.write(`\n  \x1b[33m⚠ 服务器返回: ${data.error || 'unknown'}，继续等待...\x1b[0m`)
  }
}

export async function ensureGitHubAuth() {
  // Check stored token
  const stored = await getStoredToken()
  if (stored) {
    const check = await validateToken(stored.token)
    if (check.valid) {
      return { token: stored.token, login: check.login }
    }
    // Token expired, remove it
    await logout()
  }

  // Start Device Flow
  console.log("\n\x1b[33m🔐 GitHub 账户未登录，正在启动授权...\x1b[0m\n")

  const deviceData = await requestDeviceCode()
  const { device_code, user_code, verification_uri, interval } = deviceData

  // 自动复制代码到剪贴板
  const copied = copyToClipboard(user_code)

  console.log(`  请在浏览器中打开: \x1b[36m\x1b[4m${verification_uri}\x1b[0m`)
  if (copied) {
    console.log(`  输入代码: \x1b[1m\x1b[32m${user_code}\x1b[0m  \x1b[2m✅ 已复制到剪贴板\x1b[0m\n`)
  } else {
    console.log(`  输入代码: \x1b[1m\x1b[32m${user_code}\x1b[0m\n`)
  }

  // 自动打开浏览器
  const opened = openBrowser(verification_uri)
  if (opened) {
    console.log("  \x1b[2m已自动打开浏览器，请完成授权...\x1b[0m")
    if (copied) {
      console.log("  \x1b[2m提示: 在 GitHub 页面按 Ctrl+V 粘贴代码\x1b[0m\n")
    } else {
      console.log("")
    }
  } else {
    console.log("  \x1b[33m⚠ 无法自动打开浏览器，请手动访问上述链接\x1b[0m\n")
  }

  process.stdout.write("  等待授权...")

  const token = await pollAccessToken(device_code, interval || 5)

  // Get user info
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json"
    }
  })
  if (!userRes.ok) {
    throw new Error(`Failed to get user info: ${userRes.status}`)
  }
  const user = await userRes.json()

  await saveToken({
    token,
    login: user.login,
    login_at: new Date().toISOString()
  })

  console.log(` \x1b[32m✓ 已登录为 @${user.login}\x1b[0m\n`)

  return { token, login: user.login }
}
