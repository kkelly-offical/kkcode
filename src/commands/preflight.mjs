import { Command } from "commander"
import { printContextWarnings } from "../context.mjs"
import { createKernel } from "../kernel/index.mjs"
import { loadTheme } from "../theme/load-theme.mjs"
import { checkForUpdate } from "../update/checker.mjs"
import { buildPreflightReport, formatPreflightLines, PREFLIGHT_FAIL } from "../cli/preflight.mjs"

/**
 * `kkcode preflight` — 「现在能不能正常干活」的快速自检。
 *
 * 与 doctor 的分工：doctor 是排障工具，会做 session fsck、审计链校验、
 * 后台任务统计；preflight 只看配置、provider 凭据、MCP、skills 和版本，
 * 足够轻到每次启动都跑，也适合放进容器的 healthcheck。
 *
 * 退出码：0 = 可用（含 warn），1 = 有 fail 项。
 */
export function createPreflightCommand() {
  return new Command("preflight")
    .description("check config, provider credentials, MCP, skills and version")
    .option("--json", "emit the report as JSON")
    .option("--no-update-check", "skip the registry version lookup")
    .action(async (options) => {
      // boot:false —— preflight 只按需初始化技能注册表，不拉起整套扩展
      const kernel = await createKernel({ cwd: process.cwd(), boot: false })
      if (!options.json) {
        const themeState = await loadTheme(kernel.configState)
        printContextWarnings({ configState: kernel.configState, themeState })
      }

      const policy = kernel.extensionPolicy
      const skillRegistry = kernel.extensions.skills
      await skillRegistry.initialize(policy.config, process.cwd(), {
        allowProjectSources: policy.allowProjectSources
      }).catch(() => {})

      let update = null
      if (options.updateCheck !== false) {
        update = await checkForUpdate(kernel.configState.config).catch(() => null)
        // checkForUpdate 的字段名与 preflight 的输入对齐
        if (update) update = { latest: update.latestVersion, updateAvailable: update.hasUpdate, error: update.error }
      }

      const report = buildPreflightReport({
        configState: kernel.configState,
        mcp: kernel.extensions.mcp.healthSnapshot(),
        skills: { total: skillRegistry.list().length },
        update
      })

      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        console.log("kkcode preflight")
        for (const line of formatPreflightLines(report)) console.log(line)
        if (report.status === PREFLIGHT_FAIL) {
          console.log("")
          console.log("run `kkcode doctor` for a deeper report")
        }
      }

      await kernel.shutdown().catch(() => {})
      if (report.status === PREFLIGHT_FAIL) process.exitCode = 1
    })
}
