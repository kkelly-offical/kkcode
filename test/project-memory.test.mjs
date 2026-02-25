import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  loadProjectMemory, saveProjectMemory, memoryToContext, parseMemoryFromPreview
} from "../src/session/longagent-project-memory.mjs"

describe("project-memory", () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("loadProjectMemory returns defaults when no file", async () => {
    const mem = await loadProjectMemory(tmpDir)
    assert.deepEqual(mem.techStack, [])
    assert.deepEqual(mem.patterns, [])
    assert.deepEqual(mem.conventions, [])
  })

  it("saveProjectMemory and loadProjectMemory roundtrip", async () => {
    const mem = { techStack: ["Node.js", "React"], patterns: ["MVC"], conventions: ["ESM"] }
    await saveProjectMemory(tmpDir, mem)
    const loaded = await loadProjectMemory(tmpDir)
    assert.deepEqual(loaded.techStack, ["Node.js", "React"])
    assert.deepEqual(loaded.patterns, ["MVC"])
    assert.ok(loaded.lastUpdated)
  })

  it("saveProjectMemory creates .kkcode directory", async () => {
    await saveProjectMemory(tmpDir, { techStack: ["Go"] })
    const raw = await readFile(path.join(tmpDir, ".kkcode/project-memory.json"), "utf-8")
    const parsed = JSON.parse(raw)
    assert.deepEqual(parsed.techStack, ["Go"])
  })
})

describe("memoryToContext", () => {
  it("formats memory as context string", () => {
    const ctx = memoryToContext({ techStack: ["Node.js"], patterns: ["REST"], conventions: ["ESLint"] })
    assert.ok(ctx.includes("Tech stack: Node.js"))
    assert.ok(ctx.includes("Patterns: REST"))
    assert.ok(ctx.includes("Conventions: ESLint"))
  })

  it("returns empty for no data", () => {
    assert.equal(memoryToContext({ techStack: [], patterns: [] }), "")
  })

  it("handles non-array fields gracefully", () => {
    assert.equal(memoryToContext({ techStack: "not-array", patterns: null }), "")
  })

  it("handles null input", () => {
    assert.equal(memoryToContext(null), "")
  })
})

describe("parseMemoryFromPreview", () => {
  it("extracts tech stack from text", () => {
    const mem = parseMemoryFromPreview("Tech stack: Node.js, React, PostgreSQL")
    assert.ok(mem.techStack.includes("Node.js"))
    assert.ok(mem.techStack.includes("React"))
  })

  it("extracts Chinese tech stack", () => {
    const mem = parseMemoryFromPreview("技术栈: Python, Django, Redis")
    assert.ok(mem.techStack.includes("Python"))
  })

  it("deduplicates entries", () => {
    const mem = parseMemoryFromPreview("Tech stack: Node.js, React\nFrameworks: React, Vue")
    const reactCount = mem.techStack.filter(t => t === "React").length
    assert.equal(reactCount, 1)
  })

  it("filters out invalid items", () => {
    const mem = parseMemoryFromPreview("Tech stack: 123, a, " + "x".repeat(50))
    // "123" is pure digits, "a" is too short, long string is >40 chars
    assert.equal(mem.techStack.filter(t => t === "123").length, 0)
  })

  it("returns empty for no matches", () => {
    const mem = parseMemoryFromPreview("nothing relevant here")
    assert.deepEqual(mem.techStack, [])
  })
})
