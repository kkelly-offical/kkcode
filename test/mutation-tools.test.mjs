import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { clearFileReadState, getFileReadState } from "../src/tool/file-read-state.mjs"

const config = {
  tool: {
    sources: {
      builtin: true,
      local: false,
      plugin: false,
      mcp: false
    }
  }
}

let tempDir = ""
let homeDir = ""

async function getTool(name) {
  await ToolRegistry.initialize({ config, cwd: tempDir, force: true })
  return ToolRegistry.get(name)
}

async function executeTool(name, args) {
  const tool = await getTool(name)
  return tool.execute(args, { cwd: tempDir, config })
}

function toolOutput(result) {
  return typeof result === "string" ? result : result.output
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kkcode-mutation-tools-"))
  homeDir = join(tempDir, ".home")
  await mkdir(homeDir, { recursive: true })
  process.env.KKCODE_HOME = homeDir
  clearFileReadState()
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  clearFileReadState()
  await rm(tempDir, { recursive: true, force: true })
})

test("existing-file write requires prior read", async () => {
  await writeFile(join(tempDir, "a.js"), "const a = 1\n", "utf8")

  const result = await executeTool("write", {
    path: "a.js",
    content: "const a = 2\n"
  })

  assert.match(toolOutput(result), /has not been read yet/i)
})

test("partial read does not authorize whole-file overwrite", async () => {
  await writeFile(join(tempDir, "a.js"), "line1\nline2\nline3\n", "utf8")

  await executeTool("read", {
    path: "a.js",
    offset: 2,
    limit: 1
  })

  const readState = getFileReadState(join(tempDir, "a.js"))
  assert.equal(readState?.isPartialView, true)

  const result = await executeTool("write", {
    path: "a.js",
    content: "replacement\n"
  })

  assert.match(toolOutput(result), /only partially read/i)
})

test("successful write refreshes read state and returns structured metadata", async () => {
  await writeFile(join(tempDir, "a.js"), "const a = 1\n", "utf8")
  await executeTool("read", { path: "a.js" })

  const result = await executeTool("write", {
    path: "a.js",
    content: "const a = 2\n"
  })

  const readState = getFileReadState(join(tempDir, "a.js"))
  assert.equal(readState?.content, "const a = 2\n")
  assert.equal(readState?.isPartialView, false)
  assert.equal(result.metadata.mutation.operation, "write")
  assert.ok(Array.isArray(result.metadata.mutation.structuredPatch))
})

test("edit rejects unread existing files", async () => {
  await writeFile(join(tempDir, "a.js"), "const a = 1\n", "utf8")

  const result = await executeTool("edit", {
    path: "a.js",
    before: "const a = 1",
    after: "const a = 2"
  })

  assert.match(toolOutput(result), /has not been read yet/i)
})

test("edit rejects stale files after external change", async () => {
  const filePath = join(tempDir, "a.js")
  await writeFile(filePath, "const a = 1\n", "utf8")
  await executeTool("read", { path: "a.js" })
  await writeFile(filePath, "const a = 10\n", "utf8")

  const result = await executeTool("edit", {
    path: "a.js",
    before: "const a = 1",
    after: "const a = 2"
  })

  assert.match(toolOutput(result), /has changed since it was last read/i)
})

test("patch rejects unread and stale files", async () => {
  const filePath = join(tempDir, "a.js")
  await writeFile(filePath, "one\ntwo\nthree\n", "utf8")

  const unread = await executeTool("patch", {
    path: "a.js",
    start_line: 2,
    end_line: 2,
    content: "TWO"
  })
  assert.match(toolOutput(unread), /has not been read yet/i)

  await executeTool("read", { path: "a.js" })
  await writeFile(filePath, "one\ntwo changed\nthree\n", "utf8")

  const stale = await executeTool("patch", {
    path: "a.js",
    start_line: 2,
    end_line: 2,
    content: "TWO"
  })
  assert.match(toolOutput(stale), /has changed since it was last read/i)
})

test("multiedit rejects whole batch when one file is unread", async () => {
  await writeFile(join(tempDir, "a.js"), "export const a = 1\n", "utf8")
  await writeFile(join(tempDir, "b.js"), "export const b = 1\n", "utf8")
  await executeTool("read", { path: "a.js" })

  const result = await executeTool("multiedit", {
    changes: [
      {
        path: "a.js",
        before: "export const a = 1",
        after: "export const a = 2"
      },
      {
        path: "b.js",
        before: "export const b = 1",
        after: "export const b = 2"
      }
    ]
  })

  assert.match(toolOutput(result), /has not been read yet/i)
  assert.equal(await readFile(join(tempDir, "a.js"), "utf8"), "export const a = 1\n")
  assert.equal(await readFile(join(tempDir, "b.js"), "utf8"), "export const b = 1\n")
})

test("notebookedit rejects unread and stale notebooks", async () => {
  const notebookPath = join(tempDir, "demo.ipynb")
  const notebook = JSON.stringify({
    cells: [
      {
        cell_type: "code",
        metadata: {},
        source: ["print('hi')\n"],
        execution_count: null,
        outputs: []
      }
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  }, null, 1) + "\n"

  await writeFile(notebookPath, notebook, "utf8")

  const unread = await executeTool("notebookedit", {
    path: "demo.ipynb",
    cell_number: 0,
    new_source: "print('bye')\n"
  })
  assert.match(toolOutput(unread), /has not been read yet/i)

  await executeTool("read", { path: "demo.ipynb" })
  await writeFile(notebookPath, notebook.replace("print('hi')", "print('changed')"), "utf8")

  const stale = await executeTool("notebookedit", {
    path: "demo.ipynb",
    cell_number: 0,
    new_source: "print('bye')\n"
  })
  assert.match(toolOutput(stale), /has changed since it was last read/i)
})
