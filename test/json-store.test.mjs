import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { readJson, writeJson, writeJsonAtomic } from "../src/storage/json-store.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "json-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("readJson", () => {
  it("reads valid JSON file", async () => {
    const file = path.join(tmpDir, "data.json")
    await writeJson(file, { hello: "world" })
    const result = await readJson(file, null)
    assert.deepEqual(result, { hello: "world" })
  })

  it("returns fallback for missing file", async () => {
    const result = await readJson(path.join(tmpDir, "nope.json"), { default: true })
    assert.deepEqual(result, { default: true })
  })

  it("returns fallback for invalid JSON", async () => {
    const file = path.join(tmpDir, "bad.json")
    const { writeFile: wf } = await import("node:fs/promises")
    await wf(file, "not json", "utf8")
    const result = await readJson(file, "fallback")
    assert.equal(result, "fallback")
  })
})

describe("writeJson / writeJsonAtomic", () => {
  it("creates parent directories", async () => {
    const file = path.join(tmpDir, "deep", "nested", "data.json")
    await writeJson(file, { nested: true })
    const result = await readJson(file, null)
    assert.deepEqual(result, { nested: true })
  })

  it("overwrites existing file", async () => {
    const file = path.join(tmpDir, "overwrite.json")
    await writeJson(file, { v: 1 })
    await writeJson(file, { v: 2 })
    const result = await readJson(file, null)
    assert.equal(result.v, 2)
  })

  it("writes pretty-printed JSON with trailing newline", async () => {
    const file = path.join(tmpDir, "pretty.json")
    await writeJson(file, { a: 1 })
    const raw = await readFile(file, "utf8")
    assert.ok(raw.endsWith("\n"))
    assert.ok(raw.includes("  ")) // indented
  })

  it("cleans up temp file after write", async () => {
    const file = path.join(tmpDir, "clean.json")
    await writeJson(file, { x: 1 })
    const { readdir } = await import("node:fs/promises")
    const files = await readdir(tmpDir)
    const tmpFiles = files.filter(f => f.includes(".tmp."))
    assert.equal(tmpFiles.length, 0)
  })

  it("handles concurrent writes without corruption", async () => {
    const file = path.join(tmpDir, "concurrent.json")
    await Promise.all([
      writeJson(file, { writer: "a" }),
      writeJson(file, { writer: "b" }),
      writeJson(file, { writer: "c" })
    ])
    const result = await readJson(file, null)
    assert.ok(result.writer) // one of a/b/c, but valid JSON
  })
})
