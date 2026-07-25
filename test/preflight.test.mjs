import test from "node:test"
import assert from "node:assert/strict"
import {
  buildPreflightReport,
  formatPreflightLines,
  shouldAutoInstallUpdate,
  PREFLIGHT_OK,
  PREFLIGHT_WARN,
  PREFLIGHT_FAIL
} from "../src/cli/preflight.mjs"

function configState(overrides = {}) {
  return {
    config: {
      provider: {
        default: "acme",
        acme: { base_url: "https://api.acme.test/v1", api_key_env: "ACME_KEY", default_model: "acme-1" }
      },
      permission: { level: "manual" },
      ...overrides
    },
    source: { userPath: "/home/u/.kkcode/config.yaml" },
    warnings: []
  }
}

const healthyMcp = { configured: 0, healthy: 0, unhealthy: 0 }
const someSkills = { total: 12 }

test("a fully configured setup reports ok with no problems", (t) => {
  process.env.ACME_KEY = "x"
  t.after(() => { delete process.env.ACME_KEY })

  const report = buildPreflightReport({ configState: configState(), mcp: healthyMcp, skills: someSkills })
  assert.equal(report.status, PREFLIGHT_OK)
  assert.deepEqual(report.problems, [])
  assert.equal(report.checks.provider.model, "acme-1")
  assert.equal(report.checks.skills.total, 12)
})

test("a missing api key env is a hard failure", () => {
  delete process.env.ACME_KEY
  const report = buildPreflightReport({ configState: configState(), mcp: healthyMcp, skills: someSkills })
  assert.equal(report.status, PREFLIGHT_FAIL)
  assert.equal(report.checks.provider.status, PREFLIGHT_FAIL)
  assert.match(report.checks.provider.detail, /ACME_KEY is not set/)
  assert.deepEqual(report.problems.map((p) => p.name), ["provider"])
})

test("a local endpoint without credentials is fine", () => {
  const local = configState()
  local.config.provider.acme = { base_url: "http://127.0.0.1:11434/v1", default_model: "llama" }
  const report = buildPreflightReport({ configState: local, mcp: healthyMcp, skills: someSkills })
  assert.equal(report.checks.provider.status, PREFLIGHT_OK)
  assert.match(report.checks.provider.detail, /authless local endpoint/)
})

test("an undefined default provider fails rather than passing silently", () => {
  const broken = configState()
  broken.config.provider = { default: "ghost" }
  const report = buildPreflightReport({ configState: broken, mcp: healthyMcp, skills: someSkills })
  assert.equal(report.checks.provider.status, PREFLIGHT_FAIL)
  assert.match(report.checks.provider.detail, /not defined/)
})

test("unhealthy MCP servers warn without blocking startup", (t) => {
  process.env.ACME_KEY = "x"
  t.after(() => { delete process.env.ACME_KEY })

  const report = buildPreflightReport({
    configState: configState(),
    mcp: { configured: 3, healthy: 2, unhealthy: 1 },
    skills: someSkills
  })
  assert.equal(report.status, PREFLIGHT_WARN)
  assert.equal(report.checks.mcp.status, PREFLIGHT_WARN)
  assert.match(report.checks.mcp.detail, /1 unhealthy/)
})

test("an available update warns but never fails", (t) => {
  process.env.ACME_KEY = "x"
  t.after(() => { delete process.env.ACME_KEY })

  const report = buildPreflightReport({
    configState: configState(),
    mcp: healthyMcp,
    skills: someSkills,
    update: { latest: "9.9.9", updateAvailable: true }
  })
  assert.equal(report.status, PREFLIGHT_WARN)
  assert.match(report.checks.update.detail, /-> 9\.9\.9/)

  // a failed lookup must not degrade the report
  const offline = buildPreflightReport({
    configState: configState(),
    mcp: healthyMcp,
    skills: someSkills,
    update: { error: "network down" }
  })
  assert.equal(offline.checks.update.status, PREFLIGHT_OK)
})

test("legacy permission levels surface as their 0.4.0 equivalent", (t) => {
  process.env.ACME_KEY = "x"
  t.after(() => { delete process.env.ACME_KEY })

  const legacy = configState()
  legacy.config.permission = { level: "full-auto" }
  const report = buildPreflightReport({ configState: legacy, mcp: healthyMcp, skills: someSkills })
  assert.equal(report.checks.permission.level, "accept-edits")
})

test("config warnings downgrade the report to warn", (t) => {
  process.env.ACME_KEY = "x"
  t.after(() => { delete process.env.ACME_KEY })

  const noisy = configState()
  noisy.warnings = ["unknown key agent.bogus"]
  const report = buildPreflightReport({ configState: noisy, mcp: healthyMcp, skills: someSkills })
  assert.equal(report.status, PREFLIGHT_WARN)
  assert.equal(report.checks.config.detail, "unknown key agent.bogus")
})

test("formatted lines stay aligned and cover every check", (t) => {
  process.env.ACME_KEY = "x"
  t.after(() => { delete process.env.ACME_KEY })

  const lines = formatPreflightLines(buildPreflightReport({
    configState: configState(),
    mcp: healthyMcp,
    skills: someSkills
  }))
  assert.equal(lines.length, 6)
  for (const name of ["config", "provider", "permission", "mcp", "skills", "update"]) {
    assert.ok(lines.some((l) => l.includes(name)), `missing ${name}`)
  }
  // the detail column must line up across rows
  const columns = lines.map((l) => l.indexOf(l.trim().split(/\s{2,}/)[1] || ""))
  assert.equal(new Set(columns).size, 1, `detail column misaligned: ${JSON.stringify(lines)}`)
  assert.equal(formatPreflightLines(null).length, 0)
})

test("auto-update stays off unless explicitly enabled", () => {
  assert.equal(shouldAutoInstallUpdate({}, {}), false)
  assert.equal(shouldAutoInstallUpdate({}, { KKCODE_AUTO_UPDATE: "1" }), true)
  assert.equal(shouldAutoInstallUpdate({}, { KKCODE_AUTO_UPDATE: "true" }), true)
  assert.equal(shouldAutoInstallUpdate({ update: { auto_install: true } }, {}), true)
  // the env var wins over config in both directions
  assert.equal(shouldAutoInstallUpdate({ update: { auto_install: true } }, { KKCODE_AUTO_UPDATE: "0" }), false)
  assert.equal(shouldAutoInstallUpdate({ update: { auto_install: false } }, { KKCODE_AUTO_UPDATE: "yes" }), true)
})
