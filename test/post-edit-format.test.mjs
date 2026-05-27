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
    const prettierPath = path.join(binDir, process.platform === "win32" ? "prettier.cmd" : "prettier")
    const markerPath = path.join(cwd, "marker-from-injection")
    const argsLog = path.join(cwd, "prettier-args.json")
    const maliciousPath = 'payload"; touch marker-from-injection; #.js'

    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(cwd, maliciousPath), "const x = 1\n", "utf8")
    await writeFile(prettierPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)))
`, { encoding: "utf8", mode: 0o755 })

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
