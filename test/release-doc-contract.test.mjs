import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

async function read(relPath) {
  return readFile(new URL(`../${relPath}`, import.meta.url), "utf8")
}

test("README advertises the shipped delegation, routing, and interruption contract", async () => {
  const readme = await read("README.md")

  assert.match(readme, /路由理由可见/)
  assert.match(readme, /background_output/)
  assert.match(readme, /background_cancel/)
  assert.match(readme, /completed` \/ `cancelled` \/ `error` \/ `interrupted`/)
  assert.match(readme, /Esc.*中断当前 turn/)
  assert.match(readme, /\.kkcode\/hooks\//)
  assert.match(readme, /\.kkcode-plugin\/plugin\.json/)
  assert.match(readme, /CLI 统一 Assistant 能力边界（0\.3\.0）/)
  assert.match(readme, /\/plan.*只读编写开发计划/)
  assert.match(readme, /agent.*默认统一助手/)
  assert.match(readme, /agent.*code.*coding.*兼容别名/)
  assert.match(readme, /明确重型任务.*\/ultra/)
  assert.match(readme, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(readme, /docs\/kkcode-0\.1\.13-mode-lane-contract\.md/)
})

test("README documents the 0.4.0 five-mode cycle and its compatibility mapping", async () => {
  const readme = await read("README.md")

  assert.match(readme, /Shift\+Tab/)
  for (const mode of ["plan", "agent", "agent-auto", "ultra", "yolo"]) {
    assert.match(readme, new RegExp(`\`${mode}\``), `README must document the ${mode} mode`)
  }
  for (const level of ["readonly", "manual", "accept-edits", "yolo"]) {
    assert.match(readme, new RegExp(level), `README must document the ${level} approval level`)
  }
  // the compatibility table has to stay visible while the aliases still work
  assert.match(readme, /\/longagent.*\/ultra/s)
  assert.match(readme, /docs\/kkcode-0\.4\.0-mode-contract\.md/)
})

test("0.4.0 contract doc pins the mode, approval and compatibility rules", async () => {
  const doc = await read("docs/kkcode-0.4.0-mode-contract.md")

  assert.match(doc, /Five public modes/i)
  assert.match(doc, /\(lane, approval\) pair/i)
  assert.match(doc, /Lane identifiers are unchanged from 0\.3\.x/i)
  assert.match(doc, /Always Allow/)
  assert.match(doc, /`permission\.level: auto` maps to `manual`/)
  assert.match(doc, /fast.*does not fall back to.*main/is)
  assert.match(doc, /no GUI \/ desktop automation promise/i)
  assert.match(doc, /docs\/cli-general-assistant-capability-matrix\.md/)
})

test("0.1.13 contract doc keeps the shipped scope and boundaries explicit", async () => {
  const doc = await read("docs/kkcode-0.1.13-mode-lane-contract.md")

  assert.match(doc, /assistant \/ plan \/ agent \/ longagent public lane contract/i)
  assert.match(doc, /CLI routing transparency/i)
  assert.match(doc, /default general execution lane/i)
  assert.match(doc, /plan.*does not execute file mutations/i)
  assert.match(doc, /assistant.*agent.*longagent.*upgrade paths/i)
  assert.match(doc, /CLI general assistant/i)
  assert.match(doc, /docs\/cli-general-assistant-capability-matrix\.md/)
  assert.match(doc, /no GUI \/ desktop automation promise/i)
  assert.match(doc, /keep LongAgent/i)
})
