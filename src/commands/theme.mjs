import path from "node:path"
import { access, writeFile, readFile } from "node:fs/promises"
import YAML from "yaml"
import { Command } from "commander"
import { DEFAULT_THEME } from "../theme/default-theme.mjs"
import { validateTheme } from "../theme/schema.mjs"
import { ensureProjectRoot, projectRootDir } from "../storage/paths.mjs"
import { printContextWarnings } from "../context.mjs"
import { createKernel } from "../kernel/index.mjs"
import { loadTheme } from "../theme/load-theme.mjs"
import { renderStatusBar } from "../theme/status-bar.mjs"

async function fileExists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function parseTheme(file, raw) {
  if (file.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

export function createThemeCommand() {
  const cmd = new Command("theme").description("manage kkcode theme files")

  cmd
    .command("init")
    .description("create a neo-contrast theme template in the project")
    .option("--path <file>", "output file path")
    .option("--force", "overwrite existing file", false)
    .action(async (options) => {
      await ensureProjectRoot(process.cwd())
      const target = options.path
        ? path.resolve(options.path)
        : path.join(projectRootDir(process.cwd()), "neo-contrast.theme.yaml")
      if ((await fileExists(target)) && !options.force) {
        console.error(`theme file exists: ${target} (use --force to overwrite)`)
        process.exitCode = 1
        return
      }
      await writeFile(target, YAML.stringify(DEFAULT_THEME), "utf8")
      console.log(`theme template written: ${target}`)
    })

  cmd
    .command("validate")
    .description("validate a theme file")
    .requiredOption("--file <file>", "theme file path")
    .action(async (options) => {
      const file = path.resolve(options.file)
      const raw = await readFile(file, "utf8")
      const parsed = parseTheme(file, raw)
      const check = validateTheme(parsed)
      if (!check.valid) {
        console.error("theme is invalid:")
        for (const error of check.errors) console.error(`- ${error}`)
        process.exitCode = 1
        return
      }
      console.log("theme is valid")
    })

  cmd
    .command("preview")
    .description("preview theme status bars by mode")
    .option("--file <file>", "theme file path")
    .action(async (options) => {
      const kernel = await createKernel({ cwd: process.cwd(), boot: false })
      const themeState = await loadTheme(kernel.configState, options.file ?? null)
      printContextWarnings({ configState: kernel.configState, themeState })
      const theme = themeState.theme
      const config = kernel.configState.config
      const modes = ["assistant", "plan", "agent", "longagent"]
      for (const mode of modes) {
        const line = renderStatusBar({
          mode,
          model: "anthropic/claude-sonnet-4.5",
          permission: "guarded",
          tokenMeter: {
            estimated: false,
            turn: { input: 180, output: 240 },
            session: { input: 1240, output: 2110 },
            global: { input: 8920, output: 11110 }
          },
          aggregation: config.usage.aggregation,
          cost: 0.0234,
          showCost: config.ui.status.show_cost,
          showTokenMeter: config.ui.status.show_token_meter,
          theme
        })
        console.log(line)
      }
      console.log(`theme source: ${themeState.source}`)
    })

  return cmd
}
