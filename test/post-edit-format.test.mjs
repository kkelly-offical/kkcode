import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp } from "node:fs/promises"
import postEditFormat from "../src/plugin/builtin-hooks/post-edit-format.mjs"

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

test("post-edit formatter executes local prettier without shell interpolation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "kkcode-post-edit-format-"))
  try {
    const binDir = path.join(cwd, "node_modules", ".bin")
    const prettierDir = path.join(cwd, "node_modules", "prettier")
    const prettierPath = path.join(binDir, process.platform === "win32" ? "prettier.cmd" : "prettier")
    const prettierRunner = path.join(prettierDir, "bin", "prettier.mjs")
    const markerPath = path.join(cwd, "marker-from-injection")
    const argsLog = path.join(cwd, "prettier-args.json")
    const maliciousPath = process.platform === "win32"
      ? "payload & echo marker-from-injection ; #.js"
      : 'payload"; touch marker-from-injection; #.js'

    await mkdir(binDir, { recursive: true })
    await mkdir(path.dirname(prettierRunner), { recursive: true })
    await writeFile(path.join(cwd, maliciousPath), "const x = 1\n", "utf8")
    await writeFile(path.join(prettierDir, "package.json"), JSON.stringify({
      name: "prettier",
      bin: { prettier: "bin/prettier.mjs" }
    }), "utf8")
    await writeFile(prettierRunner, `
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)))
`, "utf8")
    const launcher = process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${prettierRunner}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${prettierRunner}" "$@"\n`
    await writeFile(prettierPath, launcher, { encoding: "utf8", mode: 0o755 })

    await postEditFormat.tool.after({
      toolName: "write",
      cwd,
      args: { path: maliciousPath },
      result: { output: "ok" }
    })

    assert.equal(await exists(markerPath), false)
    assert.deepEqual(JSON.parse(await readFile(argsLog, "utf8")), ["--write", path.join(cwd, maliciousPath)])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
