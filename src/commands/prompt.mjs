import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { Command } from "commander"

const SESSION_PROMPT_DIR = path.resolve("src/session/prompt")
const TOOL_PROMPT_DIR = path.resolve("src/tool/prompt")

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

export function createPromptCommand() {
  const cmd = new Command("prompt").description("inspect prompt placement and files")

  cmd
    .command("list")
    .description("list session/tool prompt files")
    .action(async () => {
      const sessionFiles = await listFiles(SESSION_PROMPT_DIR)
      const toolFiles = await listFiles(TOOL_PROMPT_DIR)
      console.log(`session prompts: ${SESSION_PROMPT_DIR}`)
      for (const file of sessionFiles) console.log(`- ${file}`)
      console.log(``)
      console.log(`tool prompts: ${TOOL_PROMPT_DIR}`)
      for (const file of toolFiles) console.log(`- ${file}`)
    })

  cmd
    .command("show")
    .description("show one prompt file")
    .requiredOption("--type <type>", "session|tool")
    .requiredOption("--name <name>", "prompt filename")
    .action(async (options) => {
      const dir = options.type === "session" ? SESSION_PROMPT_DIR : TOOL_PROMPT_DIR
      const file = path.join(dir, options.name)
      const content = await readFile(file, "utf8")
      console.log(content.trim())
    })

  return cmd
}
