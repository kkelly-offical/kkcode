import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { Command } from "commander"
import YAML from "yaml"
import { importConfig } from "../config/import-config.mjs"
import { validateConfig } from "../config/schema.mjs"

function parseInput(file, raw) {
  if (file.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

function stringifyOutput(file, data) {
  if (file.endsWith(".json")) return JSON.stringify(data, null, 2) + "\n"
  return YAML.stringify(data)
}

export function createConfigCommand() {
  const cmd = new Command("config").description("manage kkcode config")

  cmd
    .command("import")
    .description("import external config into kkcode format")
    .requiredOption("--from <file>", "source config file path")
    .option("--to <file>", "output file path", "kkcode.config.yaml")
    .action(async (options) => {
      const from = path.resolve(options.from)
      const to = path.resolve(options.to)
      const raw = await readFile(from, "utf8")
      const parsed = parseInput(from, raw)
      const imported = importConfig(parsed)
      const check = validateConfig(imported)
      if (!check.valid) {
        console.error("import produced invalid config:")
        for (const error of check.errors) console.error(`- ${error}`)
        process.exitCode = 1
        return
      }
      await writeFile(to, stringifyOutput(to, imported), "utf8")
      console.log(`imported config written: ${to}`)
    })

  return cmd
}
