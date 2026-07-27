/**
 * Provider 与模型命令。
 *
 * 两条命令都是「裸命令 = 列出并选一个，带参 = 直接指定」的形状，所以各只有
 * 一个注册项，由 `args` 在 run 内部分流 —— 此前它们是各两个 `if` 分支，
 * 一个判等、一个判前缀，中间隔着别的命令。
 *
 * `/provider add`（而不是 `set`）是刻意的：上游分支里 add 是「列出并切换」、
 * set 是「添加」，与词义相反。用户想添加 provider 第一反应就是敲 add。
 */

import { runProviderAddForm, runProviderEditForm } from "../../provider/wizard-form.mjs"
import { escapeTerminalText, validateModelId } from "../../provider/model-id.mjs"
import { loadProviderModelItems } from "../provider-catalog.mjs"

export const providerCommands = [
  {
    names: ["provider", "p"],
    desc: "switch provider",
    argMode: "optional",
    run: async ({
      args, print, state, ctx, providersConfigured,
      setProviderPicker, openPanel, switchActiveProvider
    }) => {
      if (!args) {
        // 裸 /provider = 最常用的动作：列出并选择。add/edit 各司其名。
        if (!providersConfigured.length) {
          print("没有已配置的 provider，使用 /provider add 添加。", { channel: "notice", topic: "provider", tone: "warn" })
          return { exit: false }
        }
        const items = providersConfigured.map((name) => {
          const model = ctx.configState.config.provider?.[name]?.default_model || ""
          return { name, label: name, desc: model ? `model: ${model}` : "" }
        })
        // TUI 里这是个选择动作 —— 走可视化选择器，和 /model 一致。
        // 行模式（无 TTY）没有帧可浮，回落到编号输入：先打列表再进选择态。
        if (openPanel) {
          return { exit: false, openProviderPicker: true, providerPickerItems: items }
        }
        print("")
        items.forEach((item, i) => {
          const marker = item.name === state.providerType ? "  ✓ 当前" : ""
          print(`  ${i + 1}. ${item.name}${item.desc ? `  [${item.desc}]` : ""}${marker}`)
        })
        print("")
        print("  输入编号或名称切换（/ 开头的输入会退出选择）")
        print("  /provider add 添加新 provider · /provider edit <名称> 编辑")
        if (setProviderPicker) setProviderPicker(providersConfigured)
        return { exit: false }
      }

      const rest = args

      // /provider add — 表单流程（TUI 浮层 / readline 逐题，见 wizard-form.mjs）
      if (rest === "add") {
        const result = await runProviderAddForm({ configState: ctx.configState })
        if (!result.saved) {
          print(result.reason === "cancelled" ? "已取消，未写入任何配置。" : "未保存。", { channel: "notice", topic: "command" })
          return { exit: false }
        }
        // 热更新内存配置，让新 provider 立即可用（写盘的是原始 YAML，内存是 merged）
        if (!ctx.configState.config.provider) ctx.configState.config.provider = {}
        Object.assign(ctx.configState.config.provider, result.configPatch.provider)
        print(`provider "${result.name}" 已保存到 ~/.kkcode/config.yaml`, { channel: "notice", topic: "command", tone: "success" })
        await switchActiveProvider(result.name)
        return { exit: false }
      }
      if (rest === "set") {
        print("`/provider set` 已更名为 `/provider add`（添加新 provider）；列出并切换用裸 `/provider`。")
        return { exit: false }
      }

      // /provider edit <name> — 编辑已有 provider 配置
      if (rest.startsWith("edit ") || rest === "edit") {
        const editName = rest.replace(/^edit\s*/, "").trim()
        if (!editName) {
          print("usage: /provider edit <name>", { channel: "notice", topic: "command", tone: "error" })
          return { exit: false }
        }
        const providerCfg = ctx.configState.config?.provider?.[editName]
        if (!providerCfg || typeof providerCfg !== "object") {
          print(`provider "${editName}" 未找到，可用: ${providersConfigured.join(", ")}`, { channel: "notice", topic: "command", tone: "error" })
          return { exit: false }
        }
        const result = await runProviderEditForm({ name: editName, existing: providerCfg })
        if (!result.saved) {
          print(result.reason === "unchanged" ? "没有改动。" : "已取消。", { channel: "notice", topic: "command" })
          return { exit: false }
        }
        Object.assign(ctx.configState.config.provider, result.configPatch.provider)
        print(`provider "${editName}" 已更新（${result.changed.join(", ")}）`, { channel: "notice", topic: "command", tone: "success" })
        return { exit: false }
      }

      // /provider <name> — 切换 provider
      const next = rest
      if (!providersConfigured.includes(next)) {
        print(`provider must be one of: ${providersConfigured.join(", ")}`, { channel: "notice", topic: "command", tone: "error" })
        return { exit: false }
      }
      await switchActiveProvider(next)
      return { exit: false }
    }
  },

  {
    names: ["model"],
    desc: "open model picker",
    argMode: "optional",
    run: async ({ args, print, state, ctx }) => {
      // `/model` 与 `/model refresh` 都是「列出并选一个」；其它参数是直接指定。
      if (!args || args === "refresh") {
        const refresh = args === "refresh"
        print(`current: ${state.providerType} / ${state.model}`)
        const catalog = await loadProviderModelItems(ctx.configState, state.providerType, { refresh })
        const items = catalog.items
        if (items.length) {
          print("")
          print(`  可用模型 (${catalog.source}${catalog.stale ? ", stale" : ""})：`)
          for (const item of items) {
            const marker = (item.provider === state.providerType && item.model === state.model) ? " ●" : ""
            print(`    ${item.label}${marker}`)
          }
          print("")
          print("  用法: /model <model-id>，/model refresh 刷新目录")
        } else {
          print(`  模型目录不可用${catalog.error ? `: ${catalog.error}` : ""}`)
          print("  使用 /model <model-id> 手动设置；离线列表需在 provider.models 中由用户显式配置。")
        }
        if (catalog.warning) print(`  模型目录提示: ${catalog.warning}`)
        return {
          exit: false,
          openModelPicker: items.length > 0,
          modelPickerItems: items
        }
      }

      try {
        state.model = validateModelId(args)
        print(`model switched: ${escapeTerminalText(state.model)}`, { channel: "notice", topic: "switch" })
      } catch (error) {
        print(`invalid model id: ${escapeTerminalText(error.message)}`, { channel: "notice", topic: "command", tone: "error" })
      }
      return { exit: false }
    }
  }
]
