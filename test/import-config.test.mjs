import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { importConfig } from "../src/config/import-config.mjs"

describe("importConfig", () => {
  it("returns default config for empty input", () => {
    const cfg = importConfig({})
    assert.ok(cfg.provider)
    assert.ok(cfg.agent)
    assert.ok(cfg.ui)
  })

  it("maps llm.default_provider_type to provider.default", () => {
    const cfg = importConfig({ llm: { default_provider_type: "openai" } })
    assert.equal(cfg.provider.default, "openai")
  })

  it("maps llm.max_steps to agent.max_steps", () => {
    const cfg = importConfig({ llm: { max_steps: "50" } })
    assert.equal(cfg.agent.max_steps, 50)
  })

  it("maps llm.openai settings", () => {
    const cfg = importConfig({
      llm: {
        openai: {
          base_url: "http://localhost:8080",
          api_key_env: "MY_KEY",
          default_model: "gpt-4"
        }
      }
    })
    assert.equal(cfg.provider.openai.base_url, "http://localhost:8080")
    assert.equal(cfg.provider.openai.api_key_env, "MY_KEY")
    assert.equal(cfg.provider.openai.default_model, "gpt-4")
  })

  it("maps longagent.max_iterations", () => {
    const cfg = importConfig({ longagent: { max_iterations: 10 } })
    assert.equal(cfg.agent.longagent.max_iterations, 10)
  })

  it("maps usage settings", () => {
    const cfg = importConfig({ usage: { pricing_file: "/tmp/p.json", aggregation: ["daily"] } })
    assert.equal(cfg.usage.pricing_file, "/tmp/p.json")
    assert.deepEqual(cfg.usage.aggregation, ["daily"])
  })

  it("maps ui settings", () => {
    const cfg = importConfig({ ui: { layout: "compact" } })
    assert.equal(cfg.ui.layout, "compact")
  })

  it("normalizes permission rules from tools", () => {
    const cfg = importConfig({ tools: { bash: true, write: false } })
    const rules = cfg.permission.rules
    assert.ok(rules.some(r => r.tool === "bash" && r.action === "allow"))
    assert.ok(rules.some(r => r.tool === "write" && r.action === "deny"))
  })

  it("passes through permission.rules array", () => {
    const cfg = importConfig({ permission: { rules: [{ tool: "read", action: "allow" }] } })
    assert.ok(cfg.permission.rules.some(r => r.tool === "read"))
  })

  it("ignores non-boolean tool values", () => {
    const cfg = importConfig({ tools: { bash: "yes" } })
    const bashRules = cfg.permission.rules.filter(r => r.tool === "bash")
    assert.equal(bashRules.length, 0)
  })
})
