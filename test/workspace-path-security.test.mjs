import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { resolveWorkspacePath, WorkspaceFs, WorkspacePathError } from "../src/tool/workspace-fs.mjs"

const config = {
  tool: {
    sources: { builtin: true, local: false, plugin: false, mcp: false }
  }
}

let root
let outside

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kkcode-workspace-root-"))
  outside = await mkdtemp(join(tmpdir(), "kkcode-workspace-outside-"))
  await ToolRegistry.initialize({ config, cwd: root, force: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function tool(name, args) {
  const item = await ToolRegistry.get(name)
  return item.execute(args, { cwd: root, config })
}

test("workspace resolver rejects lexical traversal and outside absolute paths", async () => {
  await assert.rejects(
    resolveWorkspacePath(root, "../outside.txt"),
    (error) => error instanceof WorkspacePathError && error.code === "workspace_path_violation"
  )
  await assert.rejects(
    resolveWorkspacePath(root, join(outside, "outside.txt")),
    /outside working directory/
  )
})

test("read, list, glob and grep reject a symlink that escapes the workspace", async () => {
  await writeFile(join(outside, "secret.txt"), "not-for-workspace\n", "utf8")
  await symlink(outside, join(root, "escape"), "dir")

  for (const [name, args] of [
    ["read", { path: "escape/secret.txt" }],
    ["list", { path: "escape" }],
    ["glob", { pattern: "**/*", path: "escape" }],
    ["grep", { pattern: "not-for-workspace", path: "escape" }]
  ]) {
    await assert.rejects(tool(name, args), /symlink escape blocked/, `${name} should reject the escape`)
  }
})

test("write and multiedit cannot create files through an escaping symlink", async () => {
  await symlink(outside, join(root, "escape"), "dir")

  await assert.rejects(
    tool("write", { path: "escape/write.txt", content: "leaked" }),
    /symlink escape blocked/
  )
  await assert.rejects(
    tool("multiedit", {
      changes: [{ path: "escape/multi.txt", after: "leaked" }]
    }),
    /symlink escape blocked/
  )

  await assert.rejects(readFile(join(outside, "write.txt"), "utf8"), { code: "ENOENT" })
  await assert.rejects(readFile(join(outside, "multi.txt"), "utf8"), { code: "ENOENT" })
})

test("normal nested paths remain compatible", async () => {
  await mkdir(join(root, "src"), { recursive: true })
  const result = await tool("write", { path: "src/new.txt", content: "inside" })
  assert.match(result.output, /written:/)
  assert.equal(await readFile(join(root, "src/new.txt"), "utf8"), "inside")
  assert.equal(await resolveWorkspacePath(root, "src/new.txt", { mustExist: true }), join(root, "src/new.txt"))
  assert.equal(await new WorkspaceFs(root).resolve("src/new.txt", { mustExist: true }), join(root, "src/new.txt"))
})
