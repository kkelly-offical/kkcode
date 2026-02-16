import path from "node:path"
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises"

export async function readJson(file, fallback) {
  try {
    const content = await readFile(file, "utf8")
    return JSON.parse(content)
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  await mkdir(dir, { recursive: true })
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")

  // Windows can temporarily lock files and make atomic rename fail with EPERM/EBUSY.
  // Retry briefly, then fall back to direct write to keep data durable.
  let renamed = false
  let lastError = null
  const retries = [10, 30, 80, 160, 300]
  for (const delay of retries) {
    try {
      await rename(tmp, file)
      renamed = true
      break
    } catch (error) {
      lastError = error
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  if (!renamed) {
    try {
      await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
      renamed = true
    } catch (fallbackError) {
      lastError = fallbackError
    }
  }

  await unlink(tmp).catch(() => {})
  if (!renamed && lastError) throw lastError
}

export async function writeJson(file, value) {
  await writeJsonAtomic(file, value)
}
