import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { renderTemplate } from "../util/template.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_DIR = path.join(__dirname, "prompt")

const cache = new Map()

export async function loadSessionPrompt(name, vars = {}) {
  if (!cache.has(name)) {
    const file = path.join(PROMPT_DIR, name)
    const text = await readFile(file, "utf8")
    cache.set(name, text.trim())
  }
  return renderTemplate(cache.get(name), vars)
}
