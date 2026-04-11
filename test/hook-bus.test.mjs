import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { HookBus } from "../src/plugin/hook-bus.mjs"

test("hook bus exposes supported events", () => {
  const events = HookBus.supportedEvents()
  assert.ok(events.includes("chat.params"))
  assert.ok(events.includes("tool.before"))
  assert.ok(events.includes("session.compacting"))
})

test("hook bus loads .kkcode/plugins as a compatibility alias for hook scripts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kkcode-hook-bus-"))
  try {
    const pluginDir = join(cwd, ".kkcode", "plugins")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, "alias-hook.mjs"), `
      export default {
        name: "alias-hook",
        tool: {
          before(payload) {
            return { ...payload, via: "plugin-alias" }
          }
        }
      }
    `, "utf8")

    const mod = await import(`${pathToFileURL(join(process.cwd(), "src/plugin/hook-bus.mjs")).href}?t=${Date.now()}`)
    await mod.initHookBus(cwd)
    const transformed = await mod.HookBus.toolBefore({ tool: "task" })
    const loadedSources = mod.HookBus.list().map((item) => item.source)
    const warnings = mod.HookBus.errors()

    assert.equal(transformed.via, "plugin-alias")
    assert.ok(loadedSources.some((source) => source.includes(".kkcode/plugins/alias-hook.mjs")))
    assert.ok(warnings.some((item) => item.includes("deprecated hook path")))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
