import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join, delimiter } from "node:path"
import { tmpdir } from "node:os"
import postEditTypecheck from "../src/plugin/builtin-hooks/post-edit-typecheck.mjs"

let tempDir = ""
let binDir = ""
let originalPath = ""

async function installFakeNpx({ stdout = "", exitCode = 0 }) {
  const npxPath = join(binDir, "npx")
  const script = `#!/bin/sh
if [ -n "${stdout}" ]; then
  cat <<'EOF'
${stdout}
EOF
fi
exit ${exitCode}
`
  await writeFile(npxPath, script, "utf8")
  await chmod(npxPath, 0o755)
}

async function installSequencedFakeNpx(responses) {
  const npxPath = join(binDir, "npx")
  const encoded = Buffer.from(JSON.stringify(responses), "utf8").toString("base64")
  const stateFile = join(tempDir, "npx-state")
  const script = `#!/bin/sh
STATE_FILE="${stateFile}"
if [ ! -f "$STATE_FILE" ]; then
  printf '0' > "$STATE_FILE"
fi
index=$(cat "$STATE_FILE")
PAYLOAD=$(node -e "const items = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8')); const idx = Number(process.argv[1] || '0'); const item = items[Math.min(idx, items.length - 1)] || { stdout: '', exitCode: 0 }; process.stdout.write(JSON.stringify(item));" "$index")
next_index=$((index + 1))
printf '%s' "$next_index" > "$STATE_FILE"
stdout=$(node -e "const item = JSON.parse(process.argv[1]); process.stdout.write(item.stdout || '')" "$PAYLOAD")
exit_code=$(node -e "const item = JSON.parse(process.argv[1]); process.stdout.write(String(item.exitCode ?? 0))" "$PAYLOAD")
if [ -n "$stdout" ]; then
  printf '%s\n' "$stdout"
fi
exit "$exit_code"
`
  await writeFile(npxPath, script, "utf8")
  await chmod(npxPath, 0o755)
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kkcode-edit-diagnostics-"))
  binDir = join(tempDir, "bin")
  await mkdir(binDir, { recursive: true })
  originalPath = process.env.PATH || ""
  process.env.PATH = `${binDir}${delimiter}${originalPath}`
})

afterEach(async () => {
  process.env.PATH = originalPath
  await rm(tempDir, { recursive: true, force: true })
})

test("post-edit diagnostics hook ignores non-mutation and unsupported-file payloads", async () => {
  const readPayload = {
    toolName: "read",
    args: { path: "src/example.ts" },
    result: "ok",
    cwd: tempDir
  }
  const cssPayload = {
    toolName: "edit",
    args: { path: "src/example.css" },
    result: "ok",
    cwd: tempDir
  }

  const afterRead = await postEditTypecheck.tool.after(readPayload)
  const afterCss = await postEditTypecheck.tool.after(cssPayload)

  assert.equal(afterRead, readPayload)
  assert.equal(afterCss, cssPayload)
})

test("post-edit diagnostics hook appends readable diagnostics to string results", async () => {
  await writeFile(join(tempDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }), "utf8")
  await installFakeNpx({
    stdout: "src/example.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    exitCode: 2
  })

  const payload = {
    toolName: "edit",
    args: { path: "src/example.ts" },
    result: "edit complete",
    cwd: tempDir
  }

  const updated = await postEditTypecheck.tool.after(payload)

  assert.match(updated.result, /edit complete/)
  assert.match(updated.result, /Diagnostics:/)
  assert.match(updated.result, /TS2322/)
})

test("post-edit diagnostics hook appends readable diagnostics to object results for multiedit", async () => {
  await writeFile(join(tempDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }), "utf8")
  await installFakeNpx({
    stdout: "src/b.ts(2,1): error TS1005: ';' expected.",
    exitCode: 1
  })

  const payload = {
    toolName: "multiedit",
    args: {
      changes: [
        { path: "src/a.ts" },
        { path: "src/b.ts" }
      ]
    },
    result: { output: "2 file(s) updated atomically" },
    cwd: tempDir
  }

  const updated = await postEditTypecheck.tool.after(payload)

  assert.match(updated.result.output, /2 file\(s\) updated atomically/)
  assert.match(updated.result.output, /Diagnostics:/)
  assert.match(updated.result.output, /TS1005/)
})

test("post-edit diagnostics hook computes baseline vs after diagnostics delta when before hook ran", async () => {
  await writeFile(join(tempDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }), "utf8")
  await installSequencedFakeNpx([
    {
      stdout: "src/example.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      exitCode: 2
    },
    {
      stdout: "src/example.ts(2,9): error TS2304: Cannot find name 'nextValue'.",
      exitCode: 2
    }
  ])

  const beforePayload = await postEditTypecheck.tool.before({
    tool: "edit",
    args: { path: "src/example.ts" },
    cwd: tempDir
  })

  const afterPayload = await postEditTypecheck.tool.after({
    ...beforePayload,
    tool: "edit",
    args: beforePayload.args,
    result: { output: "edit complete", metadata: { mutation: { operation: "edit" } } },
    cwd: tempDir
  })

  const diagnostics = afterPayload.result.metadata.diagnostics
  assert.equal(diagnostics.contract, "kkcode/edit-diagnostics@1")
  assert.equal(diagnostics.delta.added.length, 1)
  assert.equal(diagnostics.delta.resolved.length, 1)
  assert.equal(diagnostics.delta.persisted.length, 0)
  assert.match(afterPayload.result.output, /introduced 1 diagnostic, resolved 1 diagnostic/i)
  assert.match(afterPayload.result.output, /TS2304/)
})

test("post-edit diagnostics hook works with runtime payloads that use tool instead of toolName", async () => {
  await writeFile(join(tempDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }), "utf8")
  await installFakeNpx({
    stdout: "src/example.ts(1,7): error TS2304: Cannot find name 'missingValue'.",
    exitCode: 2
  })

  const updated = await postEditTypecheck.tool.after({
    tool: "write",
    args: { path: "src/example.ts" },
    result: { output: "written", metadata: {} },
    cwd: tempDir
  })

  assert.match(updated.result.output, /TS2304/)
  assert.equal(updated.result.metadata.diagnostics.contract, "kkcode/edit-diagnostics@1")
})

test("post-edit diagnostics hook reports unavailable diagnostics when tsconfig is absent", async () => {
  await installFakeNpx({
    stdout: "this should not be surfaced",
    exitCode: 1
  })

  const payload = {
    toolName: "write",
    args: { path: "src/example.ts" },
    result: { output: "written" },
    cwd: tempDir
  }

  const updated = await postEditTypecheck.tool.after(payload)

  assert.match(updated.result.output, /diagnostics unavailable/i)
  assert.equal(updated.result.metadata.diagnostics.summary.status, "unavailable")
})
