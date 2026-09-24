import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, unlink, rm, access } from "node:fs/promises"
import { openPinnedDirectory } from "../src/util/pinned-io.mjs"

const linux = { skip: process.platform !== "linux" }
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "kk-office-pinned-"))
  const workspace = path.join(base, "workspace"), outside = path.join(base, "outside")
  await mkdir(workspace); await mkdir(outside)
  const pinned = await openPinnedDirectory(workspace)
  t.after(async () => { await pinned.close(); await rm(base, { recursive: true, force: true }) })
  return { base, workspace, outside, pinned }
}

test("Office input directory replacement never opens an outside canary", linux, async t => {
  const { workspace, outside, pinned } = await fixture(t)
  await mkdir(path.join(workspace, "inputs"))
  await writeFile(path.join(workspace, "inputs", "doc.md"), "inside")
  await writeFile(path.join(outside, "doc.md"), "DO NOT READ OUTSIDE")
  const selected = await pinned.openDirectory("inputs")
  try {
    // This is the exact gap that path realpath/lstat/open chains cannot protect.
    await rename(path.join(workspace, "inputs"), path.join(workspace, "retired"))
    await symlink(outside, path.join(workspace, "inputs"))
    const file = await selected.openFile("doc.md")
    try { assert.equal(await file.readFile("utf8"), "inside") } finally { await file.close() }
    await assert.rejects(pinned.openFile("inputs/doc.md"), error => error.code === "pinned_scope")
  } finally { await selected.close() }
})

test("Office publication pins its destination before an attacker swaps the parent", linux, async t => {
  const { workspace, outside, pinned } = await fixture(t)
  const output = await pinned.createDirectory("deliveries/report")
  try {
    await rename(path.join(workspace, "deliveries"), path.join(workspace, "retired"))
    await symlink(outside, path.join(workspace, "deliveries"))
    const file = await output.openFile("result.md", { create: true })
    try { await file.writeFile("safe artifact"); await file.sync() } finally { await file.close() }
    assert.equal(await readFile(path.join(workspace, "retired", "report", "result.md"), "utf8"), "safe artifact")
    assert.equal(await access(path.join(outside, "report", "result.md")).then(() => true, () => false), false)
    await assert.rejects(pinned.openFile("deliveries/report/result.md"), error => error.code === "pinned_scope")
  } finally { await output.close() }
})

test("Office concurrent directory swaps never cross the pinned workspace boundary", linux, async t => {
  const { workspace, outside, pinned } = await fixture(t)
  const live = path.join(workspace, "input"), saved = path.join(workspace, "saved")
  await mkdir(live); await writeFile(path.join(live, "doc.md"), "inside")
  await writeFile(path.join(outside, "doc.md"), "OUTSIDE SECRET")
  let stop = false, swaps = 0
  const attacker = (async () => {
    while (!stop) {
      await rename(live, saved); await symlink(outside, live)
      await new Promise(resolve => setImmediate(resolve))
      await unlink(live); await rename(saved, live); swaps++
    }
  })()
  try {
    for (let i = 0; i < 250; i++) {
      let file
      try {
        file = await pinned.openFile("input/doc.md")
        assert.equal(await file.readFile("utf8"), "inside")
      } catch (error) { if (!["pinned_scope", "ENOENT"].includes(error.code)) throw error }
      finally { await file?.close() }
    }
  } finally { stop = true; await attacker }
  assert.ok(swaps > 0)
})

test("Office fails closed where directory-relative I/O cannot be guaranteed", { skip: process.platform === "linux" }, async () => {
  await assert.rejects(openPinnedDirectory(path.resolve(os.tmpdir())), error => error.code === "pinned_scope")
})
