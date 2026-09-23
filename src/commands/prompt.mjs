import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { Command } from "commander"
import { fileURLToPath } from 'node:url'
import { inspectPrompt } from '../kernel/index.mjs'

const SESSION_PROMPT_DIR = fileURLToPath(new URL('../kernel/session/prompt/', import.meta.url))
const TOOL_PROMPT_DIR = fileURLToPath(new URL('../kernel/tool/prompt/', import.meta.url))

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

export function createPromptCommand() {
  const cmd = new Command("prompt").description("inspect prompt placement and files")
  cmd.command('inspect').description('inspect the last actual request budget and prompt provenance, without prompt text')
    .requiredOption('--session <id>', 'local session identifier')
    .action(async options => { console.log(JSON.stringify(await inspectPrompt(options.session), null, 2)) })

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
      if (!['session', 'tool'].includes(options.type)) throw new Error('Prompt type must be session or tool')
      const dir = options.type === "session" ? SESSION_PROMPT_DIR : TOOL_PROMPT_DIR
      if (!/^[a-z0-9_-]+\.txt$/i.test(options.name)) throw new Error('Use a prompt filename from prompt list')
      const file = path.join(dir, options.name)
      const content = await readFile(file, "utf8")
      console.log(content.trim())
    })

  return cmd
}
