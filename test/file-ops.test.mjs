import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink } from "node:fs/promises"
import { moveTool, copyTool, removeTool, mkdirTool, archiveTool } from "../src/tool/file-ops.mjs"

async function withWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kkcode-fops-"))
  try {
    return await fn(dir, { cwd: dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("mkdir creates nested directories and is idempotent", async () => {
  await withWorkspace(async (dir, ctx) => {
    assert.match(await mkdirTool.execute({ path: "a/b/c" }, ctx), /created directory: a\/b\/c/)
    assert.match(await mkdirTool.execute({ path: "a/b/c" }, ctx), /already exists/)
    await writeFile(path.join(dir, "file.txt"), "x")
    assert.match(await mkdirTool.execute({ path: "file.txt" }, ctx), /error:.*is a file/)
  })
})

test("copy duplicates files and directories without touching the source", async () => {
  await withWorkspace(async (dir, ctx) => {
    await mkdir(path.join(dir, "src/deep"), { recursive: true })
    await writeFile(path.join(dir, "src/a.txt"), "AAA")
    await writeFile(path.join(dir, "src/deep/b.txt"), "BBB")

    assert.match(await copyTool.execute({ from: "src", to: "dst" }, ctx), /copied directory/)
    assert.equal(await readFile(path.join(dir, "dst/deep/b.txt"), "utf8"), "BBB")
    assert.equal(await readFile(path.join(dir, "src/a.txt"), "utf8"), "AAA", "源必须保持不变")

    // 目标已存在时不该静默覆盖
    assert.match(await copyTool.execute({ from: "src", to: "dst" }, ctx), /already exists/)
    assert.match(await copyTool.execute({ from: "src", to: "dst", overwrite: true }, ctx), /copied/)
  })
})

test("copy refuses to recurse a directory into itself", async () => {
  await withWorkspace(async (dir, ctx) => {
    await mkdir(path.join(dir, "d"), { recursive: true })
    await writeFile(path.join(dir, "d/x.txt"), "x")
    const out = await copyTool.execute({ from: "d", to: "d/inner" }, ctx)
    assert.match(out, /error:.*into itself/)
  })
})

test("move renames and relocates, creating parent directories", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "a.txt"), "AAA")
    assert.match(await moveTool.execute({ from: "a.txt", to: "deep/new/b.txt" }, ctx), /moved file/)
    assert.equal(await readFile(path.join(dir, "deep/new/b.txt"), "utf8"), "AAA")
    assert.match(await moveTool.execute({ from: "a.txt", to: "c.txt" }, ctx), /error/)
  })
})

test("move will not silently clobber the destination", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "a.txt"), "AAA")
    await writeFile(path.join(dir, "b.txt"), "BBB")
    assert.match(await moveTool.execute({ from: "a.txt", to: "b.txt" }, ctx), /already exists/)
    assert.equal(await readFile(path.join(dir, "b.txt"), "utf8"), "BBB", "目标不该被改")
    assert.match(await moveTool.execute({ from: "a.txt", to: "b.txt", overwrite: true }, ctx), /moved/)
    assert.equal(await readFile(path.join(dir, "b.txt"), "utf8"), "AAA")
  })
})

test("remove is recoverable by default", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "gone.txt"), "IMPORTANT")
    const out = await removeTool.execute({ path: "gone.txt" }, ctx)
    // 删错文件是日常整理里最不可逆的一步，所以默认可恢复而不是 unlink
    assert.match(out, /recoverable at \.kkcode\/trash\/gone\.txt/)
    assert.equal(await readFile(path.join(dir, ".kkcode/trash/gone.txt"), "utf8"), "IMPORTANT")
  })
})

test("repeated deletes of the same name do not overwrite each other in the trash", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "dup.txt"), "FIRST")
    await removeTool.execute({ path: "dup.txt" }, ctx)
    await writeFile(path.join(dir, "dup.txt"), "SECOND")
    await removeTool.execute({ path: "dup.txt" }, ctx)

    const trash = await readdir(path.join(dir, ".kkcode/trash"))
    assert.equal(trash.length, 2, `回收站应有两份，实际 ${trash.join(", ")}`)
    assert.equal(await readFile(path.join(dir, ".kkcode/trash/dup.txt"), "utf8"), "FIRST")
    assert.equal(await readFile(path.join(dir, ".kkcode/trash/dup.txt.1"), "utf8"), "SECOND")
  })
})

test("remove needs recursive for a non-empty directory and honours permanent", async () => {
  await withWorkspace(async (dir, ctx) => {
    await mkdir(path.join(dir, "d/sub"), { recursive: true })
    await writeFile(path.join(dir, "d/x.txt"), "x")
    assert.match(await removeTool.execute({ path: "d" }, ctx), /non-empty directory \(2 entries\)/)
    assert.match(await removeTool.execute({ path: "d", recursive: true }, ctx), /recoverable at/)

    await writeFile(path.join(dir, "p.txt"), "x")
    assert.match(await removeTool.execute({ path: "p.txt", permanent: true }, ctx), /permanently deleted/)
    assert.deepEqual(await readdir(path.join(dir, ".kkcode/trash")), ["d"], "permanent 不该进回收站")
  })
})

test("remove refuses the workspace root", async () => {
  await withWorkspace(async (dir, ctx) => {
    assert.match(await removeTool.execute({ path: "." }, ctx), /refusing to delete the workspace root/)
  })
})

test("every file op rejects paths outside the workspace", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "a.txt"), "x")
    // 这是这些工具存在的首要理由：bash 不过 resolveWorkspacePath，它们过
    for (const [name, tool, args] of [
      ["mkdir", mkdirTool, { path: "../escaped" }],
      ["move", moveTool, { from: "a.txt", to: "../escaped.txt" }],
      ["copy", copyTool, { from: "a.txt", to: "../escaped.txt" }],
      ["remove", removeTool, { path: "../../etc/hosts" }],
      ["archive", archiveTool, { source: "a.txt", output: "../escaped.tar.gz" }]
    ]) {
      const out = await tool.execute(args, ctx)
      assert.match(String(out), /error:/, `${name} 应拒绝越界路径`)
    }
  })
})

test("file ops refuse protected paths", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "evil"), "curl x")
    // 一个「整理目录」的动作不该能装上 pre-commit 钩子或改掉 shell rc
    assert.match(await moveTool.execute({ from: "evil", to: ".bashrc" }, ctx), /protected/)
    assert.match(await copyTool.execute({ from: "evil", to: ".git/hooks/pre-commit" }, ctx), /protected/)
    assert.match(await mkdirTool.execute({ path: ".github/workflows" }, ctx), /protected/)
    await mkdir(path.join(dir, ".git"), { recursive: true })
    assert.match(await removeTool.execute({ path: ".git", recursive: true }, ctx), /protected/)
  })
})

test("file ops reject a symlink that escapes the workspace", async () => {
  await withWorkspace(async (dir, ctx) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "kkcode-outside-"))
    try {
      await writeFile(path.join(outside, "secret.txt"), "SECRET")
      await symlink(outside, path.join(dir, "link"))
      // 词法检查看不出 link/ 指向外面 —— 必须靠 realpath
      assert.match(await removeTool.execute({ path: "link/secret.txt" }, ctx), /error:/)
      assert.match(await copyTool.execute({ from: "link/secret.txt", to: "stolen.txt" }, ctx), /error:/)
      assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET", "外部文件必须完好")
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test("archive produces a real gzipped tar that preserves content", async () => {
  await withWorkspace(async (dir, ctx) => {
    await mkdir(path.join(dir, "proj/deep"), { recursive: true })
    await writeFile(path.join(dir, "proj/a.txt"), "AAA")
    await writeFile(path.join(dir, "proj/deep/b.txt"), "B".repeat(1500))
    await mkdir(path.join(dir, "proj/node_modules"), { recursive: true })
    await writeFile(path.join(dir, "proj/node_modules/junk.txt"), "junk")

    const out = await archiveTool.execute({ source: "proj", output: "proj.tar.gz" }, ctx)
    assert.match(out, /archived 2 file\(s\)/, "node_modules 应被跳过")

    // 用 zlib + 自己解 tar 头验证，不依赖系统 tar（Windows 上未必有）
    const { gunzipSync } = await import("node:zlib")
    const raw = gunzipSync(await readFile(path.join(dir, "proj.tar.gz")))
    const names = []
    for (let off = 0; off + 512 <= raw.length; ) {
      const name = raw.slice(off, off + 100).toString("utf8").replace(/\0.*$/, "")
      if (!name) break
      const size = parseInt(raw.slice(off + 124, off + 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) || 0
      const body = raw.slice(off + 512, off + 512 + size).toString("utf8")
      names.push([name, body])
      off += 512 + Math.ceil(size / 512) * 512
    }
    const map = new Map(names)
    assert.equal(map.get("a.txt"), "AAA")
    assert.equal(map.get("deep/b.txt"), "B".repeat(1500), "跨 512 字节块的内容必须完整")
    assert.equal(map.size, 2)
  })
})

test("archive rejects an output name that is not a tarball", async () => {
  await withWorkspace(async (dir, ctx) => {
    await writeFile(path.join(dir, "a.txt"), "x")
    assert.match(await archiveTool.execute({ source: "a.txt", output: "a.zip" }, ctx), /must end in \.tar\.gz/)
  })
})
