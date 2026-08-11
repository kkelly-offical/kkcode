import test from "node:test"
import assert from "node:assert/strict"
import { printContextWarnings } from "../src/context.mjs"

function captureErrors(fn) {
  const lines = []
  const original = console.error
  console.error = (...args) => lines.push(args.join(" "))
  try {
    fn()
  } finally {
    console.error = original
  }
  return lines
}

test("normal command startup prints pruned config warnings", () => {
  const lines = captureErrors(() => printContextWarnings({
    configState: {
      errors: [],
      warnings: ["project.yaml: agent.max_steps: must be integer（该项已忽略）"]
    },
    themeState: { errors: [] }
  }))

  assert.ok(lines.some((line) => line.includes("config warning")))
  assert.ok(lines.some((line) => line.includes("agent.max_steps")))
})

test("hard config errors do not claim every other layer fell back to defaults", () => {
  const lines = captureErrors(() => printContextWarnings({
    configState: {
      errors: ["project.yaml: permission.level: must be readonly|manual"],
      warnings: []
    },
    themeState: { errors: [] }
  }))

  assert.ok(lines.some((line) => line.includes("config error")))
  assert.ok(lines.every((line) => !line.includes("当前使用默认配置")),
    "用户层或其他已验证层可能仍生效，不能谎称全部退回 defaults")
})
