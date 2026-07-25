import path from "node:path"
import readline from "node:readline"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { Command } from "commander"
import YAML from "yaml"
import { loadConfig } from "../config/load-config.mjs"
import { VENDOR_PRESETS } from "../provider/wizard.mjs"
import { userRootDir } from "../storage/paths.mjs"

// --- Save provider config (same pattern as wizard's _saveProviderConfig) ---

async function saveProviderConfig(newCfg, setDefault = true) {
  const configPath = path.join(userRootDir(), "config.yaml")
  await mkdir(path.dirname(configPath), { recursive: true })

  let existing = {}
  try {
    const raw = await readFile(configPath, "utf8")
    existing = YAML.parse(raw) || {}
  } catch {
    // File doesn't exist, start fresh
  }

  if (!existing.provider) existing.provider = {}
  for (const [key, value] of Object.entries(newCfg.provider)) {
    if (key === "default") continue
    existing.provider[key] =
      value && typeof value === "object"
        ? { ...(existing.provider[key] || {}), ...value }
        : value
  }
  if (setDefault && newCfg.provider.default) {
    existing.provider.default = newCfg.provider.default
  }

  await writeFile(configPath, YAML.stringify(existing), "utf8")
}

// --- Resolve configured providers ---

function getConfiguredProviders(configState) {
  const provider = configState.config.provider || {}
  const metaKeys = new Set(["default", "strict_mode", "model_context"])
  const names = Object.keys(provider).filter((k) => !metaKeys.has(k))
  return names.map((name) => ({
    name,
    config: provider[name],
    label: VENDOR_PRESETS[name]?.label || provider[name]?.type || name,
    isActive: provider.default === name
  }))
}

// --- Print formatted provider list ---

function printProviderList(providers) {
  const active = providers.find((p) => p.isActive)
  if (active) {
    const model = active.config?.default_model || "N/A"
    console.log(`\n  当前 Provider: ${active.name} (${model})\n`)
  }
  console.log("  已配置的 Provider:")
  const maxNameLen = Math.max(...providers.map((p) => p.name.length), 6)
  const maxLabelLen = Math.max(...providers.map((p) => p.label.length), 8)

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]
    const num = String(i + 1).padStart(3, " ")
    const name = p.name.padEnd(maxNameLen)
    const label = p.label.padEnd(maxLabelLen)
    const model = p.config?.default_model || "N/A"
    const marker = p.isActive ? "  \u2713 当前" : ""
    console.log(`    ${num}. ${name}  ${label}  [${model}]${marker}`)
  }
  console.log()
}

// --- Main command ---

export function createProviderCommand() {
  const command = new Command("provider").description(
    "manage and switch AI providers"
  )

  // Default action: interactive menu
  command.action(async () => {
    const configState = await loadConfig(process.cwd())
    const providers = getConfiguredProviders(configState)

    if (providers.length === 0) {
      console.log(
        "\n  没有已配置的 provider。使用 kkcode 向导或手动编辑 ~/.kkcode/config.yaml 添加。\n"
      )
      return
    }

    printProviderList(providers)

    const answer = await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })
      rl.question("  输入编号或名称切换 (回车取消): ", (ans) => {
        rl.close()
        resolve(ans)
      })
    })

    const input = answer.trim()
    if (!input) {
      console.log("  已取消。\n")
      return
    }

    let target = null
    const num = Number(input)
    if (!isNaN(num) && num >= 1 && num <= providers.length) {
      target = providers[num - 1]
    } else {
      target = providers.find((p) => p.name === input)
    }

    if (!target) {
      console.error(`\n  找不到 provider: "${input}"`)
      console.error(`  可用: ${providers.map((p) => p.name).join(", ")}\n`)
      process.exitCode = 1
      return
    }

    if (target.isActive) {
      console.log(`\n  "${target.name}" 已经是当前 provider。\n`)
      return
    }

    await saveProviderConfig({ provider: { default: target.name } })
    const model = target.config?.default_model || "N/A"
    console.log(
      `\n  已切换到 "${target.name}" (${model}) → ~/.kkcode/config.yaml\n`
    )
  })

  // list subcommand
  command
    .command("list")
    .description("list all configured providers")
    .action(async () => {
      const configState = await loadConfig(process.cwd())
      const providers = getConfiguredProviders(configState)

      if (providers.length === 0) {
        console.log("没有已配置的 provider。")
        return
      }

      for (const p of providers) {
        const marker = p.isActive ? " *" : ""
        console.log(`${p.name}${marker}`)
      }
    })

  // switch subcommand
  command
    .command("switch <name>")
    .description("switch to a specific provider")
    .action(async (name) => {
      const configState = await loadConfig(process.cwd())
      const providers = getConfiguredProviders(configState)

      const target = providers.find((p) => p.name === name)
      if (!target) {
        console.error(`找不到 provider: "${name}"`)
        if (providers.length > 0) {
          console.error(`可用: ${providers.map((p) => p.name).join(", ")}`)
        } else {
          console.error("没有已配置的 provider。")
        }
        process.exitCode = 1
        return
      }

      if (target.isActive) {
        console.log(`"${name}" 已经是当前 provider。`)
        return
      }

      await saveProviderConfig({ provider: { default: name } })
      console.log(`已切换到 "${name}" → ~/.kkcode/config.yaml`)
    })

  // current subcommand
  command
    .command("current")
    .description("show the currently active provider")
    .action(async () => {
      const configState = await loadConfig(process.cwd())
      const defaultName = configState.config.provider?.default
      if (!defaultName) {
        console.log("未设置默认 provider。")
        return
      }
      const providerConfig = configState.config.provider?.[defaultName]
      const model = providerConfig?.default_model || "N/A"
      const label =
        VENDOR_PRESETS[defaultName]?.label ||
        providerConfig?.type ||
        defaultName
      console.log(`${defaultName} (${label}) — ${model}`)
    })

  return command
}
