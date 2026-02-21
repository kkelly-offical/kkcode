import { readFile, writeFile, unlink, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
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

async function pollAccessToken(deviceCode, interval) {
  while (true) {
    await sleep(interval * 1000)
    const res = await fetch(ACCESS_TOKEN_URL, {
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
    const data = await res.json()

    if (data.access_token) {
      return data.access_token
    }
    if (data.error === "authorization_pending") {
      continue
    }
    if (data.error === "slow_down") {
      interval = (data.interval || interval) + 1
      continue
    }
    if (data.error === "expired_token") {
      throw new Error("Authorization timed out. Please try again.")
    }
    if (data.error === "access_denied") {
      throw new Error("Authorization denied by user.")
    }
    throw new Error(`Unexpected error: ${data.error || JSON.stringify(data)}`)
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

  console.log(`  请在浏览器中打开: \x1b[36m\x1b[4m${verification_uri}\x1b[0m`)
  console.log(`  输入代码: \x1b[1m\x1b[32m${user_code}\x1b[0m\n`)

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
