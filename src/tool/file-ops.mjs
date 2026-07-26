import path from "node:path"
import { stat, rename, mkdir, cp, readdir, rm, writeFile } from "node:fs/promises"
import { createWriteStream, createReadStream } from "node:fs"
import { createGzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { resolveWorkspacePath } from "./workspace-fs.mjs"
import { findProtectedTarget } from "../permission/protected-paths.mjs"

/**
 * 文件管理工具：move / copy / remove / mkdir / archive。
 *
 * 此前**一个都没有** —— 「整理一下这个目录」在物理上做不到，模型只能退回
 * bash，而 bash 恰好是绕过所有路径校验的那条路。做成专用工具换来三件事：
 *
 *   1. 路径必过 resolveWorkspacePath（含 symlink 逃逸检查），bash 不过
 *   2. 确切的权限判定 —— `remove` 是 edit 能力，不是"某条 shell 命令"
 *   3. **可撤销的删除**：进回收站目录而非 unlink。这是 bash 给不了的，
 *      而删错文件是日常整理里最不可逆的一步
 *
 * 前沿工具里 opencode 与 Claude Code 都没把这些做成独立工具（都走 bash），
 * 所以第 3 条是这里刻意超出同行的地方 —— 理由是 kkcode 跑在全自动 git 模式
 * 下，删除发生在快照之外时无从恢复。
 */

const TRASH_DIR = ".kkcode/trash"
const MAX_ARCHIVE_ENTRIES = 20000

function schema(type, description) {
  return { type, description }
}

async function guardPath(root, requested, { mustExist = false, forWrite = true } = {}) {
  const resolved = await resolveWorkspacePath(root, requested, { mustExist })
  if (forWrite) {
    const rel = path.relative(root, resolved).split(path.sep).join("/")
    const hit = findProtectedTarget([rel])
    if (hit) {
      const error = new Error(`${hit.path} is protected: ${hit.reason}`)
      error.code = "PROTECTED_PATH"
      throw error
    }
  }
  return resolved
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/") || "."
}

async function pathKind(target) {
  try {
    const info = await stat(target)
    return info.isDirectory() ? "directory" : "file"
  } catch {
    return null
  }
}

export const moveTool = {
  name: "move",
  description: "Move or rename a file or directory within the workspace. Fails if the destination exists unless overwrite is true. Parent directories of the destination are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      from: schema("string", "source path, relative to the workspace root"),
      to: schema("string", "destination path, relative to the workspace root"),
      overwrite: schema("boolean", "replace the destination if it exists (default: false)")
    },
    required: ["from", "to"]
  },
  async execute(args, ctx = {}) {
    const root = ctx.cwd || process.cwd()
    try {
      const from = await guardPath(root, String(args.from || ""), { mustExist: true })
      const to = await guardPath(root, String(args.to || ""))
      const kind = await pathKind(from)
      if (!kind) return `error: ${args.from} does not exist`

      const destKind = await pathKind(to)
      if (destKind && !args.overwrite) {
        return `error: ${args.to} already exists (${destKind}). Pass overwrite: true to replace it.`
      }
      if (destKind && args.overwrite) await rm(to, { recursive: true, force: true })

      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to).catch(async (error) => {
        // 跨设备（EXDEV）时 rename 不可用 —— 容器里 /tmp 与工作区常在不同挂载点
        if (error?.code !== "EXDEV") throw error
        await cp(from, to, { recursive: true })
        await rm(from, { recursive: true, force: true })
      })
      return `moved ${kind}: ${rel(root, from)} → ${rel(root, to)}`
    } catch (error) {
      return `error: ${error.message}`
    }
  }
}

export const copyTool = {
  name: "copy",
  description: "Copy a file or directory within the workspace. Directories are copied recursively. Fails if the destination exists unless overwrite is true.",
  inputSchema: {
    type: "object",
    properties: {
      from: schema("string", "source path, relative to the workspace root"),
      to: schema("string", "destination path, relative to the workspace root"),
      overwrite: schema("boolean", "replace the destination if it exists (default: false)")
    },
    required: ["from", "to"]
  },
  async execute(args, ctx = {}) {
    const root = ctx.cwd || process.cwd()
    try {
      const from = await guardPath(root, String(args.from || ""), { mustExist: true, forWrite: false })
      const to = await guardPath(root, String(args.to || ""))
      const kind = await pathKind(from)
      if (!kind) return `error: ${args.from} does not exist`

      const destKind = await pathKind(to)
      if (destKind && !args.overwrite) {
        return `error: ${args.to} already exists (${destKind}). Pass overwrite: true to replace it.`
      }

      // 目录复制到自身子路径会无限递归 —— cp 不一定拦，这里显式拦
      if (kind === "directory" && (to === from || to.startsWith(from + path.sep))) {
        return `error: cannot copy ${args.from} into itself (${args.to})`
      }

      await mkdir(path.dirname(to), { recursive: true })
      await cp(from, to, { recursive: kind === "directory", force: Boolean(args.overwrite) })
      return `copied ${kind}: ${rel(root, from)} → ${rel(root, to)}`
    } catch (error) {
      return `error: ${error.message}`
    }
  }
}

export const removeTool = {
  name: "remove",
  description: "Delete a file or directory. By default it moves the target into .kkcode/trash so it can be restored — pass permanent: true to delete outright. Directories need recursive: true.",
  inputSchema: {
    type: "object",
    properties: {
      path: schema("string", "path to delete, relative to the workspace root"),
      recursive: schema("boolean", "required to delete a non-empty directory (default: false)"),
      permanent: schema("boolean", "delete outright instead of moving to .kkcode/trash (default: false)")
    },
    required: ["path"]
  },
  async execute(args, ctx = {}) {
    const root = ctx.cwd || process.cwd()
    try {
      const target = await guardPath(root, String(args.path || ""), { mustExist: true })
      if (path.resolve(target) === path.resolve(root)) {
        return "error: refusing to delete the workspace root"
      }
      const kind = await pathKind(target)
      if (!kind) return `error: ${args.path} does not exist`
      if (kind === "directory") {
        const entries = await readdir(target)
        if (entries.length && !args.recursive) {
          return `error: ${args.path} is a non-empty directory (${entries.length} entries). Pass recursive: true to delete it.`
        }
      }

      if (args.permanent) {
        await rm(target, { recursive: true, force: true })
        return `permanently deleted ${kind}: ${rel(root, target)}`
      }

      // 回收站路径带序号而非时间戳：Date.now() 在同一毫秒内两次删除会撞名，
      // 而序号只依赖磁盘现状，可重复推演。
      const trashRoot = path.join(root, TRASH_DIR)
      await mkdir(trashRoot, { recursive: true })
      const base = path.basename(target)
      let dest = path.join(trashRoot, base)
      for (let n = 1; await pathKind(dest); n++) {
        dest = path.join(trashRoot, `${base}.${n}`)
      }
      await rename(target, dest).catch(async (error) => {
        if (error?.code !== "EXDEV") throw error
        await cp(target, dest, { recursive: true })
        await rm(target, { recursive: true, force: true })
      })
      return `deleted ${kind}: ${rel(root, target)} → recoverable at ${rel(root, dest)}`
    } catch (error) {
      return `error: ${error.message}`
    }
  }
}

export const mkdirTool = {
  name: "mkdir",
  description: "Create a directory, including any missing parent directories. Succeeds silently if it already exists.",
  inputSchema: {
    type: "object",
    properties: {
      path: schema("string", "directory path to create, relative to the workspace root")
    },
    required: ["path"]
  },
  async execute(args, ctx = {}) {
    const root = ctx.cwd || process.cwd()
    try {
      const target = await guardPath(root, String(args.path || ""))
      const existing = await pathKind(target)
      if (existing === "directory") return `directory already exists: ${rel(root, target)}`
      if (existing === "file") return `error: ${args.path} exists and is a file`
      await mkdir(target, { recursive: true })
      return `created directory: ${rel(root, target)}`
    } catch (error) {
      return `error: ${error.message}`
    }
  }
}

async function collectFiles(root, dir, out = [], budget = { left: MAX_ARCHIVE_ENTRIES }) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (budget.left <= 0) return out
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      await collectFiles(root, full, out, budget)
    } else if (entry.isFile()) {
      out.push(full)
      budget.left--
    }
  }
  return out
}

export const archiveTool = {
  name: "archive",
  description: "Create a .tar.gz archive of a file or directory. Skips .git and node_modules. Use this to bundle logs, back up a directory before a risky change, or produce a deliverable.",
  inputSchema: {
    type: "object",
    properties: {
      source: schema("string", "file or directory to archive, relative to the workspace root"),
      output: schema("string", "archive path ending in .tar.gz (default: <source>.tar.gz)")
    },
    required: ["source"]
  },
  async execute(args, ctx = {}) {
    const root = ctx.cwd || process.cwd()
    try {
      const source = await guardPath(root, String(args.source || ""), { mustExist: true, forWrite: false })
      const outName = String(args.output || `${args.source}.tar.gz`)
      if (!outName.endsWith(".tar.gz") && !outName.endsWith(".tgz")) {
        return `error: output must end in .tar.gz or .tgz (got ${outName})`
      }
      const output = await guardPath(root, outName)
      const kind = await pathKind(source)
      if (!kind) return `error: ${args.source} does not exist`

      const files = kind === "file" ? [source] : await collectFiles(root, source)
      if (!files.length) return `error: ${args.source} contains no files to archive`

      await mkdir(path.dirname(output), { recursive: true })
      const base = kind === "file" ? path.dirname(source) : source
      const chunks = []
      for (const file of files) {
        const info = await stat(file)
        const name = path.relative(base, file).split(path.sep).join("/")
        chunks.push(tarHeader(name, info.size, info.mtimeMs))
        chunks.push({ file, size: info.size })
      }

      const gzip = createGzip()
      const writeStream = createWriteStream(output)
      const done = pipeline(gzip, writeStream)
      for (const chunk of chunks) {
        if (chunk.file) {
          await new Promise((resolve, reject) => {
            const rs = createReadStream(chunk.file)
            rs.on("error", reject)
            rs.on("end", () => {
              const pad = (512 - (chunk.size % 512)) % 512
              if (pad) gzip.write(Buffer.alloc(pad))
              resolve()
            })
            rs.pipe(gzip, { end: false })
          })
        } else {
          gzip.write(chunk)
        }
      }
      gzip.end(Buffer.alloc(1024)) // tar 结束标记：两个空块
      await done

      const outInfo = await stat(output)
      const capped = files.length >= MAX_ARCHIVE_ENTRIES
      return [
        `archived ${files.length} file(s) → ${rel(root, output)} (${outInfo.size} bytes)`,
        capped ? `[capped] stopped at ${MAX_ARCHIVE_ENTRIES} entries; the archive is incomplete.` : ""
      ].filter(Boolean).join("\n")
    } catch (error) {
      return `error: ${error.message}`
    }
  }
}

/**
 * 最小 ustar 头。自己写而不引依赖：仓库零运行时依赖，为一个归档工具引入
 * tar 包不值当；而 ustar 头就是 512 字节的固定布局。
 */
function tarHeader(name, size, mtimeMs) {
  const block = Buffer.alloc(512)
  let prefix = ""
  let filename = name
  if (Buffer.byteLength(name) > 100) {
    // ustar 的 prefix 字段：长路径拆成 prefix(155) + name(100)
    const cut = name.lastIndexOf("/", name.length - 100)
    if (cut > 0) {
      prefix = name.slice(0, cut)
      filename = name.slice(cut + 1)
    } else {
      filename = name.slice(-100)
    }
  }
  block.write(filename, 0, 100, "utf8")
  block.write("0000644\0", 100, 8, "ascii")           // mode
  block.write("0000000\0", 108, 8, "ascii")           // uid
  block.write("0000000\0", 116, 8, "ascii")           // gid
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii")
  block.write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii")
  block.write("        ", 148, 8, "ascii")            // checksum 占位（空格）
  block.write("0", 156, 1, "ascii")                   // typeflag: 普通文件
  block.write("ustar\0" + "00", 257, 8, "ascii")
  if (prefix) block.write(prefix, 345, 155, "utf8")

  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")
  return block
}

export const fileOpsTools = [moveTool, copyTool, removeTool, mkdirTool, archiveTool]
