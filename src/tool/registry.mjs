import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { access, stat, unlink } from "node:fs/promises"
import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { atomicWriteFile, replaceInFileTransactional, replaceAllInFileTransactional, diffLineCount } from "./edit-transaction.mjs"
import { withFileLock } from "./file-lock-manager.mjs"
import { BackgroundManager } from "../orchestration/background-manager.mjs"
import { createTaskTool } from "./task-tool.mjs"
import { McpRegistry } from "../mcp/registry.mjs"
import { SkillRegistry } from "../skill/registry.mjs"
import { askQuestionInteractive } from "./question-prompt.mjs"

const exec = promisify(execCb)

const state = {
  initialized: false,
  tools: [],
  loadedAt: 0,
  lastSignature: "",
  lastCwd: "",
  lastConfig: null
}

function schema(type, description) {
  return { type, description }
}

function safeStringify(value) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

function signatureFor(config = {}, cwd = process.cwd()) {
  const payload = {
    cwd,
    tool: config.tool || {},
    mcp: config.mcp || {},
    runtime: config.runtime || {}
  }
  return JSON.stringify(payload)
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function listDir(dir) {
  const items = await readdir(dir, { withFileTypes: true })
  return items.map((item) => `${item.isDirectory() ? "d" : "f"} ${item.name}`).join("\n")
}

// Track which files have been read in this session (for edit safety)
const fileReadTracker = new Map() // path -> { readAt: timestamp }

function markFileRead(filePath) {
  fileReadTracker.set(filePath, { readAt: Date.now() })
}

function wasFileRead(filePath) {
  return fileReadTracker.has(filePath)
}

async function runGlob(pattern, cwd, searchPath) {
  if (!pattern) return "pattern is required"
  const escaped = pattern.replace(/"/g, '\\"')
  const target = searchPath ? path.resolve(cwd, searchPath) : "."
  const command = `rg --files --glob "${escaped}" "${target}"`
  const out = await exec(command, { cwd, timeout: 15000, encoding: "utf8" }).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? error.message
  }))
  const text = `${out.stdout || ""}`.trim()
  if (!text) return "no files matched"
  const lines = text.split("\n").filter(Boolean)
  if (lines.length > 200) {
    return lines.slice(0, 200).join("\n") + `\n... (+${lines.length - 200} more files)`
  }
  return `${lines.length} file(s):\n${text}`
}

async function runGrep(pattern, cwd, options = {}) {
  if (!pattern) return "pattern is required"
  const parts = ["rg"]
  // Output mode
  if (options.multiline) parts.push("-U", "--multiline-dotall")
  if (options.outputMode === "count") parts.push("-c")
  else if (options.outputMode === "files") parts.push("-l")
  else parts.push("-n") // content mode (default)
  // Context
  if (options.beforeContext) parts.push("-B", String(options.beforeContext))
  if (options.afterContext) parts.push("-A", String(options.afterContext))
  if (options.context) parts.push("-C", String(options.context))
  // Filters
  if (options.type) parts.push("--type", options.type)
  if (options.glob) parts.push("--glob", `"${options.glob}"`)
  if (options.maxCount) parts.push("-m", String(options.maxCount))
  if (options.ignoreCase) parts.push("-i")
  const escaped = process.platform === "win32" ? `"${pattern}"` : `'${pattern}'`
  const target = options.path ? `"${path.resolve(cwd, options.path)}"` : "."
  parts.push(escaped, target)
  const command = parts.join(" ")
  const out = await exec(command, { cwd, timeout: 30000, encoding: "utf8" }).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? error.message
  }))
  let text = `${out.stdout || ""}${out.stderr || ""}`.trim()
  // Post-process: offset + head_limit for pagination
  if (text && (options.offset || options.headLimit)) {
    const lines = text.split("\n")
    const start = options.offset || 0
    const limit = options.headLimit || lines.length
    text = lines.slice(start, start + limit).join("\n")
  }
  return text || "no matches"
}

const LONG_RUNNING_PATTERNS = [
  /\bnpm\s+run\s+dev\b/i,
  /\bnpm\s+run\s+start\b/i,
  /\bnpm\s+start\b/i,
  /\byarn\s+dev\b/i,
  /\byarn\s+start\b/i,
  /\bpnpm\s+dev\b/i,
  /\bpnpm\s+start\b/i,
  /\bnpx\s+vite\b/i,
  /\bnpx\s+next\s+dev\b/i,
  /\bnpx\s+serve\b/i,
  /\bnode\s+.*server/i,
  /\bwebpack\s+serve\b/i,
  /\bwebpack\s+--watch\b/i,
  /\bjest\s+--watch\b/i,
  /\bvitest(?!\s+--run)\b.*(?!--run)/i,
  /\bnodemon\b/i,
  /\btsc\s+--watch\b/i,
  /\btailwindcss\s+--watch\b/i,
  /\bnpm\s+run\s+serve\b/i,
  /\bnpm\s+run\s+watch\b/i
]

const BASH_TIMEOUT_MS = 120_000
const IS_WIN = process.platform === "win32"
function wrapCmd(cmd) { return IS_WIN ? `chcp 65001 >nul & ${cmd}` : cmd }

function isLongRunningCommand(command) {
  const cmd = String(command || "").trim()
  return LONG_RUNNING_PATTERNS.some((re) => re.test(cmd))
}

async function runBash(command, cwd, timeoutMs = BASH_TIMEOUT_MS) {
  if (isLongRunningCommand(command)) {
    return `[blocked] "${command}" looks like a long-running/dev-server command that would block execution. Please tell the user to run it manually in their terminal, or use run_in_background: true.`
  }
  const out = await exec(wrapCmd(command), { cwd, timeout: timeoutMs, encoding: "utf8" }).catch((error) => {
    if (error.killed || error.signal === "SIGTERM") {
      return {
        stdout: error.stdout ?? "",
        stderr: `${error.stderr || ""}\n[timeout] command killed after ${timeoutMs / 1000}s`
      }
    }
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message
    }
  })
  return `${out.stdout || ""}${out.stderr || ""}`.trim() || "(empty output)"
}

function lockOptions(ctx = {}) {
  const mode = String(ctx?.config?.tool?.write_lock?.mode || "file_lock")
  const waitTimeoutMs = Math.max(0, Number(ctx?.config?.tool?.write_lock?.wait_timeout_ms || 120000))
  const owner = String(ctx?.taskId || ctx?.sessionId || ctx?.turnId || "kkcode")
  return { mode, waitTimeoutMs, owner }
}

async function loadDynamicTools(dirs) {
  const loaded = []
  for (const dir of dirs) {
    const absolute = path.resolve(dir)
    if (!(await exists(absolute))) continue
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (![".mjs", ".js"].includes(path.extname(entry.name).toLowerCase())) continue
      const file = path.join(absolute, entry.name)
      try {
        const mod = await import(pathToFileURL(file).href)
        const def = mod.default || mod.tool || mod
        if (!def || typeof def !== "object" || typeof def.name !== "string" || typeof def.execute !== "function") {
          continue
        }
        loaded.push({
          name: def.name,
          description: def.description || `dynamic tool from ${file}`,
          inputSchema: def.inputSchema || { type: "object", properties: {}, required: [] },
          execute: def.execute
        })
      } catch {
        // ignore invalid tool module
      }
    }
  }
  return loaded
}

function builtinTools() {
  const listTool = {
    name: "list",
    description: "List files and subdirectories in a directory. Returns entry names with type prefix (d=directory, f=file). Use this for quick directory overview; use `glob` for recursive pattern matching.",
    inputSchema: {
      type: "object",
      properties: { path: schema("string", "directory path") },
      required: []
    },
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path || ".")
      return listDir(target)
    }
  }

  const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"])
  const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" }

  function readNotebook(raw) {
    const notebook = JSON.parse(raw)
    if (!notebook.cells || !Array.isArray(notebook.cells)) return "Not a valid .ipynb file (missing cells array)"
    const lines = []
    notebook.cells.forEach((cell, i) => {
      const type = cell.cell_type || "unknown"
      lines.push(`--- Cell ${i} [${type}] ---`)
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "")
      lines.push(source)
      if (cell.outputs && cell.outputs.length > 0) {
        lines.push("[Output]:")
        for (const out of cell.outputs) {
          if (out.text) lines.push(Array.isArray(out.text) ? out.text.join("") : String(out.text))
          else if (out.data?.["text/plain"]) {
            const plain = out.data["text/plain"]
            lines.push(Array.isArray(plain) ? plain.join("") : String(plain))
          }
        }
      }
      lines.push("")
    })
    return lines.join("\n")
  }

  function extractPdfText(buffer) {
    // Basic PDF text extraction: find text between BT/ET operators and parenthesized strings
    const str = buffer.toString("latin1")
    const texts = []
    const tjRegex = /\(([^)]*)\)/g
    // Extract strings from content streams
    let match
    while ((match = tjRegex.exec(str)) !== null) {
      const decoded = match[1]
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t").replace(/\\\\/g, "\\")
        .replace(/\\([()])/g, "$1")
      if (decoded.trim()) texts.push(decoded)
    }
    if (texts.length === 0) return "(PDF contains no extractable text — may be image-based or encrypted)"
    return texts.join(" ").replace(/\s+/g, " ").trim()
  }

  const readTool = {
    name: "read",
    description: "Read file content with line numbers. Supports text files, images (PNG/JPG/GIF/SVG/WebP/BMP/ICO as base64), PDF (text extraction), and Jupyter notebooks (.ipynb cell parsing). Use `offset` and `limit` to read specific line ranges. ALWAYS use this instead of `bash` with cat/head/tail. You MUST read a file before editing it with `edit`.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        offset: schema("number", "start line number (1-based, optional)"),
        limit: schema("number", "max lines to return (optional)"),
        encoding: schema("string", "file encoding (default: utf8)"),
        pages: schema("string", "page range for PDF files, e.g. '1-5' (optional)")
      },
      required: ["path"]
    },
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path)
      const ext = path.extname(target).toLowerCase()
      markFileRead(target)

      // Image files: return base64 data URI
      if (IMAGE_EXTENSIONS.has(ext)) {
        const buffer = await readFile(target)
        const base64 = buffer.toString("base64")
        const mime = IMAGE_MIME[ext] || "application/octet-stream"
        return {
          type: "image",
          output: `Image file: ${args.path} (${buffer.length} bytes, ${mime})`,
          data: `data:${mime};base64,${base64}`
        }
      }

      // PDF files: extract text
      if (ext === ".pdf") {
        const buffer = await readFile(target)
        return extractPdfText(buffer)
      }

      // Jupyter notebooks: parse cells
      if (ext === ".ipynb") {
        const raw = await readFile(target, "utf8")
        return readNotebook(raw)
      }

      // Default: text file with line numbers
      const encoding = args.encoding || "utf8"
      const content = await readFile(target, encoding)
      const allLines = content.split("\n")
      const start = Math.max(0, (Number(args.offset) || 1) - 1)
      const count = Number(args.limit) || allLines.length
      const slice = allLines.slice(start, start + count)
      const numbered = slice.map((line, i) => {
        const num = String(start + i + 1).padStart(6)
        const truncated = line.length > 2000 ? line.slice(0, 2000) + "... (truncated)" : line
        return `${num}→${truncated}`
      })
      return numbered.join("\n")
    }
  }

  const writeTool = {
    name: "write",
    description: "Create or overwrite a file atomically. Auto-creates parent directories. Include ALL content in a single call — do NOT split across multiple writes. Use `edit` instead when only a small part of an existing file needs to change.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        content: schema("string", "new file content")
      },
      required: ["path", "content"]
    },
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path)
      const content = String(args.content ?? "")

      // Guard: detect empty/parse-error writes that would destroy existing content
      if (args.__parse_error) {
        return {
          output: `error: tool call arguments were corrupted (JSON parse failed). The write was NOT executed. This usually means the response was truncated — try generating a shorter file or use the edit tool for incremental changes.`,
          metadata: { blocked: true, reason: "parse_error" }
        }
      }
      if (!content && !args.content) {
        return {
          output: `error: content is empty or missing. The write was NOT executed. If you intended to create an empty file, pass content as an empty string explicitly.`,
          metadata: { blocked: true, reason: "empty_content" }
        }
      }

      let previous = ""
      const options = lockOptions(ctx)
      const runWrite = async () => {
        try {
          previous = await readFile(target, "utf8")
        } catch {
          previous = ""
        }
        await atomicWriteFile(target, content)
      }
      if (options.mode === "file_lock") {
        await withFileLock({
          targetPath: target,
          owner: options.owner,
          waitTimeoutMs: options.waitTimeoutMs,
          run: runWrite
        })
      } else {
        await runWrite()
      }
      const diff = diffLineCount(previous, content)
      const addedLines = diff.added
      const removedLines = diff.removed
      return {
        output: `written: ${target}`,
        metadata: {
          fileChanges: [
            {
              path: String(args.path || target),
              tool: "write",
              addedLines,
              removedLines,
              stageId: ctx.stageId || null,
              taskId: ctx.logicalTaskId || ctx.taskId || null
            }
          ]
        }
      }
    }
  }

  const editTool = {
    name: "edit",
    description: "Replace a specific text snippet in an existing file. Transactional with automatic rollback on failure. You MUST `read` the file first — edits on unread files are rejected. Provide enough surrounding context in `before` to ensure a unique match. Set `replace_all: true` to replace ALL occurrences.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "file path"),
        before: schema("string", "target snippet"),
        after: schema("string", "replacement snippet"),
        replace_all: schema("boolean", "replace all occurrences instead of requiring unique match (default: false)")
      },
      required: ["path", "before", "after"]
    },
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path)
      // Safety: warn if file was not read first
      if (!wasFileRead(target)) {
        const fileExists = await exists(target)
        if (fileExists) {
          return {
            output: `warning: you should read "${args.path}" before editing it. Use the read tool first to understand the file content, then retry the edit.`,
            metadata: { fileChanges: [] }
          }
        }
      }
      // Safety: check if file was modified externally since last read
      const readInfo = fileReadTracker.get(target)
      if (readInfo) {
        try {
          const fileStat = await stat(target)
          if (fileStat.mtimeMs > readInfo.readAt + 500) {
            return {
              output: `warning: "${args.path}" was modified since you last read it. Read it again to see the latest content before editing.`,
              metadata: { fileChanges: [] }
            }
          }
        } catch { /* file may not exist yet */ }
      }
      const options = lockOptions(ctx)
      const runEdit = async () =>
        args.replace_all
          ? replaceAllInFileTransactional(target, String(args.before), String(args.after))
          : replaceInFileTransactional(target, String(args.before), String(args.after))
      const result = options.mode === "file_lock"
        ? await withFileLock({
            targetPath: target,
            owner: options.owner,
            waitTimeoutMs: options.waitTimeoutMs,
            run: runEdit
          })
        : await runEdit()
      // Update read tracker after successful edit
      markFileRead(target)
      return {
        output: result.output,
        metadata: {
          fileChanges: [
            {
              path: String(args.path || target),
              tool: "edit",
              addedLines: Number(result.addedLines || 0),
              removedLines: Number(result.removedLines || 0),
              stageId: ctx.stageId || null,
              taskId: ctx.logicalTaskId || ctx.taskId || null
            }
          ]
        }
      }
    }
  }

  const globTool = {
    name: "glob",
    description: "Find files by glob pattern recursively. Use this instead of `bash` with find/ls. Optionally specify a `path` to search within a specific directory. Returns up to 200 matching file paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: schema("string", "glob pattern, e.g. **/*.mjs, src/**/*.ts"),
        path: schema("string", "directory to search in (default: cwd)")
      },
      required: ["pattern"]
    },
    async execute(args, ctx) {
      return runGlob(String(args.pattern || ""), ctx.cwd, args.path || null)
    }
  }

  const grepTool = {
    name: "grep",
    description: "Search file contents by regex pattern. Use this instead of `bash` with grep/rg. Supports searching within a specific file or directory via `path`, output modes (content/files/count), multiline matching, context lines, and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: schema("string", "regex or string pattern"),
        path: schema("string", "file or directory to search in (default: cwd). Use this to search within a specific file."),
        output_mode: schema("string", "output mode: 'content' (lines with numbers), 'files' (file paths only, default), 'count' (match counts per file)"),
        type: schema("string", "file type filter, e.g. js, ts, py (optional)"),
        glob: schema("string", "glob filter, e.g. *.mjs, src/**/*.ts (optional)"),
        maxCount: schema("number", "max matches per file (optional)"),
        context: schema("number", "lines of context around match, -C (optional)"),
        before_context: schema("number", "lines before each match, -B (optional)"),
        after_context: schema("number", "lines after each match, -A (optional)"),
        ignoreCase: schema("boolean", "case insensitive search (optional)"),
        multiline: schema("boolean", "enable cross-line matching (optional)"),
        head_limit: schema("number", "limit output to first N lines/entries (optional)"),
        offset: schema("number", "skip first N lines/entries before head_limit (optional)")
      },
      required: ["pattern"]
    },
    async execute(args, ctx) {
      return runGrep(String(args.pattern || ""), ctx.cwd, {
        path: args.path || null,
        outputMode: args.output_mode || "files",
        type: args.type || null,
        glob: args.glob || null,
        maxCount: args.maxCount || null,
        context: args.context || null,
        beforeContext: args.before_context || null,
        afterContext: args.after_context || null,
        ignoreCase: !!args.ignoreCase,
        multiline: !!args.multiline,
        headLimit: args.head_limit || null,
        offset: args.offset || null
      })
    }
  }

  const bashTool = {
    name: "bash",
    description: "Run a shell command in cwd. ONLY use for commands that have no dedicated tool (e.g. git, npm, pip, docker). Do NOT use for: reading files (use `read`), searching files (use `grep`/`glob`), writing files (use `write`/`edit`). Long-running commands are blocked unless run_in_background is true.",
    inputSchema: {
      type: "object",
      properties: {
        command: schema("string", "shell command"),
        timeout: schema("number", "timeout in ms (default 120000, max 600000)"),
        description: schema("string", "human-readable description of what this command does (optional)"),
        run_in_background: schema("boolean", "run as background task, returns task_id immediately (optional)")
      },
      required: ["command"]
    },
    async execute(args, ctx) {
      const command = String(args.command || "")
      const timeoutMs = Math.min(Math.max(Number(args.timeout) || BASH_TIMEOUT_MS, 1000), 600_000)

      if (args.run_in_background) {
        // Launch as background task
        const task = await BackgroundManager.launch({
          description: args.description || command,
          payload: { command, cwd: ctx.cwd },
          run: async () => {
            const out = await exec(wrapCmd(command), { cwd: ctx.cwd, timeout: 600_000, encoding: "utf8" })
              .catch(e => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }))
            return `${out.stdout || ""}${out.stderr || ""}`.trim() || "(empty output)"
          },
          config: ctx.config
        })
        return `background task launched: ${task.id}\nUse background_output to check results.`
      }

      return runBash(command, ctx.cwd, timeoutMs)
    }
  }

  const outputTool = {
    name: "background_output",
    description: "Retrieve status, logs, and result of a background task launched via `task` with `run_in_background: true`. Returns the task object including status and output.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id")
      },
      required: ["task_id"]
    },
    async execute(args) {
      const task = await BackgroundManager.get(String(args.task_id || ""))
      if (!task) return "background task not found"
      return task
    }
  }

  const cancelTool = {
    name: "background_cancel",
    description: "Cancel a running background task by its task_id. Only works on tasks launched via `task` with `run_in_background: true`.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: schema("string", "background task id")
      },
      required: ["task_id"]
    },
    async execute(args) {
      const ok = await BackgroundManager.cancel(String(args.task_id || ""))
      return ok ? "cancel requested" : "background task not found"
    }
  }

  const todowriteTool = {
    name: "todowrite",
    description: "Create or update a structured task list for tracking multi-step work. ALWAYS create a todo list before starting any task with 2+ steps. Mark items in_progress/completed as you work. Only ONE item should be in_progress at a time.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list",
          items: {
            type: "object",
            properties: {
              content: schema("string", "task description in imperative form (e.g. 'Run tests')"),
              activeForm: schema("string", "present continuous form shown during execution (e.g. 'Running tests')"),
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "task status" }
            },
            required: ["content", "status"]
          }
        }
      },
      required: ["todos"]
    },
    async execute(args, ctx) {
      const todos = args.todos || []
      ctx._todoState = todos
      const summary = todos.map((t) => {
        const active = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : ""
        return `[${t.status}] ${t.content}${active}`
      }).join("\n")
      return `Todo list updated (${todos.length} items):\n${summary}`
    }
  }

  const questionTool = {
    name: "question",
    description: "Ask the user one or more structured questions and wait for their answers. Use when you need user input to proceed — e.g. ambiguous requirements, implementation choices, or missing information. Supports predefined options, multi-select, and custom text input. Returns actual user answers.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "questions to ask the user",
          items: {
            type: "object",
            properties: {
              id: schema("string", "unique question identifier"),
              text: schema("string", "question text"),
              header: schema("string", "short label for tab chip (max 12 chars)"),
              description: schema("string", "supplementary description (optional)"),
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: schema("string", "option display text"),
                    value: schema("string", "option value (defaults to label)"),
                    description: schema("string", "option description (optional)")
                  },
                  required: ["label"]
                },
                description: "predefined choices (optional)"
              },
              multi: schema("boolean", "allow multiple selections (default false)"),
              allowCustom: schema("boolean", "allow custom text input (default true)")
            },
            required: ["id", "text"]
          }
        }
      },
      required: ["questions"]
    },
    async execute(args) {
      if (args && args._allowQuestion === false) {
        return "question tool disabled in this phase"
      }
      const questions = Array.isArray(args.questions) ? args.questions : []
      if (questions.length === 0) {
        return "error: at least one question is required"
      }
      // Normalize questions
      const normalized = questions.map((q, i) => ({
        id: String(q.id || `q${i}`),
        text: String(q.text || ""),
        description: q.description ? String(q.description) : "",
        options: Array.isArray(q.options) ? q.options.map((o) => ({
          label: String(o.label || ""),
          value: String(o.value || o.label || ""),
          description: o.description ? String(o.description) : ""
        })) : [],
        multi: !!q.multi,
        allowCustom: q.allowCustom !== false
      }))
      const answers = await askQuestionInteractive({ questions: normalized })
      // Format response
      const lines = normalized.map((q) => {
        const answer = answers[q.id] ?? "(skipped)"
        return `[${q.id}] ${q.text} → ${answer}`
      })
      return lines.join("\n")
    }
  }

  const webfetchTool = {
    name: "webfetch",
    description: "Fetch content from a public URL and return it as text. HTML is converted to markdown. Content over 50KB is truncated. Only use for public, unauthenticated URLs. Do NOT use for local file reading — use `read` instead.",
    inputSchema: {
      type: "object",
      properties: {
        url: schema("string", "URL to fetch"),
        prompt: schema("string", "optional processing instruction")
      },
      required: ["url"]
    },
    async execute(args) {
      const url = String(args.url || "")
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return "error: URL must start with http:// or https://"
      }
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "kkcode/0.1" },
          signal: AbortSignal.timeout(30000)
        })
        if (!response.ok) return `error: HTTP ${response.status}`
        const text = await response.text()
        const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n...(truncated)" : text
        return truncated
      } catch (error) {
        return `error: ${error.message}`
      }
    }
  }

  const skillTool = {
    name: "skill",
    description: "Invoke a registered skill by name. Skills are pre-built prompt templates or programmable modules that provide specialized capabilities. Use this when a task matches an available skill listed in the system prompt, or when the user mentions a slash command like '/commit'.",
    inputSchema: {
      type: "object",
      properties: {
        skill: schema("string", "skill name without '/' prefix (e.g. 'commit', 'init', 'frontend')"),
        args: schema("string", "optional arguments to pass to the skill (e.g. 'vue' for /init vue)")
      },
      required: ["skill"]
    },
    async execute(args, ctx) {
      const name = String(args.skill || "").trim()
      if (!name) return "error: skill name is required"
      if (!SkillRegistry.isReady()) return "error: skill registry not initialized"
      const skill = SkillRegistry.get(name)
      if (!skill) {
        const available = SkillRegistry.list().map(s => s.name).join(", ")
        return `error: skill "${name}" not found. Available: ${available}`
      }
      const result = await SkillRegistry.execute(name, String(args.args || ""), {
        cwd: ctx.cwd,
        mode: ctx.mode || "agent",
        model: ctx.model || "",
        provider: ctx.provider || ""
      })
      if (!result) return `skill /${name} returned no output`
      return result
    }
  }

  const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
  const EXA_TIMEOUT_MS = 25000

  async function callExaMcp(toolName, args, signal) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    })
    const response = await fetch(EXA_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body,
      signal: signal || AbortSignal.timeout(EXA_TIMEOUT_MS)
    })
    if (!response.ok) {
      const err = await response.text().catch(() => "")
      throw new Error(`Exa search error (${response.status}): ${err}`)
    }
    const text = await response.text()
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6))
        if (data.result?.content?.[0]?.text) return data.result.content[0].text
      }
    }
    return null
  }

  const websearchTool = {
    name: "websearch",
    description: "Search the web for up-to-date information. Use this PROACTIVELY when you are unsure about facts, APIs, library versions, error messages, or anything beyond your training data. Reduces hallucination by grounding answers in real search results. Returns relevant web page content.",
    inputSchema: {
      type: "object",
      properties: {
        query: schema("string", "search query"),
        numResults: schema("number", "number of results to return (default: 5)"),
        type: schema("string", "search type: 'auto' (default), 'fast' (quick), 'deep' (comprehensive)")
      },
      required: ["query"]
    },
    async execute(args, ctx) {
      const query = String(args.query || "").trim()
      if (!query) return "error: query is required"
      try {
        const result = await callExaMcp("web_search_exa", {
          query,
          numResults: Number(args.numResults) || 5,
          type: args.type || "auto",
          livecrawl: "fallback"
        }, ctx.signal)
        return result || "No results found. Try a different query."
      } catch (error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") return "error: search request timed out"
        return `error: ${error.message}`
      }
    }
  }

  const codesearchTool = {
    name: "codesearch",
    description: "Search for code examples, API documentation, and SDK usage. Use this PROACTIVELY when working with unfamiliar libraries, frameworks, or APIs. Returns relevant code snippets and documentation from the web. Especially useful for: correct API signatures, configuration examples, migration guides, and best practices.",
    inputSchema: {
      type: "object",
      properties: {
        query: schema("string", "search query for APIs, libraries, SDKs (e.g. 'Express.js middleware', 'React useState hook')"),
        tokensNum: schema("number", "amount of context to return, 1000-50000 (default: 5000)")
      },
      required: ["query"]
    },
    async execute(args, ctx) {
      const query = String(args.query || "").trim()
      if (!query) return "error: query is required"
      try {
        const result = await callExaMcp("get_code_context_exa", {
          query,
          tokensNum: Math.min(Math.max(Number(args.tokensNum) || 5000, 1000), 50000)
        }, ctx.signal)
        return result || "No code context found. Try a more specific query."
      } catch (error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") return "error: code search request timed out"
        return `error: ${error.message}`
      }
    }
  }

  const multieditTool = {
    name: "multiedit",
    description: "Apply multiple file edits atomically in a single operation. All changes succeed together or are rolled back entirely. Use this instead of multiple sequential `edit` calls when modifying related code across files (e.g. renaming an export and updating all imports). Each file must have been `read` first.",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          description: "list of file changes to apply atomically",
          items: {
            type: "object",
            properties: {
              path: schema("string", "file path"),
              before: schema("string", "text to find (required for edits, omit for new file creation)"),
              after: schema("string", "replacement text (for edits) or full content (for new files)"),
              replace_all: schema("boolean", "replace all occurrences of before (default: false)")
            },
            required: ["path", "after"]
          }
        }
      },
      required: ["changes"]
    },
    async execute(args, ctx) {
      const changes = Array.isArray(args.changes) ? args.changes : []
      if (!changes.length) return "error: at least one change is required"

      // Phase 1: validate all changes and collect original content for rollback
      const snapshots = [] // { path, original, isNew }
      const resolved = []
      for (const change of changes) {
        const target = path.resolve(ctx.cwd, change.path)
        const isCreate = !change.before && change.before !== ""
        if (!isCreate && !wasFileRead(target)) {
          const fileExists = await exists(target)
          if (fileExists) {
            return `error: you must read "${change.path}" before editing it. Use the read tool first.`
          }
        }
        let original = null
        try {
          original = await readFile(target, "utf8")
        } catch { /* new file */ }

        if (!isCreate) {
          const matches = (original || "").split(change.before).length - 1
          if (matches === 0) return `error: no match for "before" in ${change.path}. Re-read the file and check your snippet.`
          if (matches > 1 && !change.replace_all) return `error: ${matches} matches in ${change.path} — set replace_all: true or provide more context.`
        }

        snapshots.push({ path: target, original, isNew: original === null })
        resolved.push({ target, ...change, isCreate })
      }

      // Phase 2: apply all changes
      const applied = []
      try {
        for (const change of resolved) {
          if (change.isCreate) {
            await atomicWriteFile(change.target, String(change.after))
          } else {
            const content = await readFile(change.target, "utf8")
            const next = change.replace_all
              ? content.replaceAll(change.before, change.after)
              : content.replace(change.before, change.after)
            await atomicWriteFile(change.target, next)
          }
          markFileRead(change.target)
          applied.push(change.target)
        }
      } catch (error) {
        // Rollback all applied changes
        for (let i = applied.length - 1; i >= 0; i--) {
          const snap = snapshots.find(s => s.path === applied[i])
          if (!snap) continue
          try {
            if (snap.isNew) {
              await unlink(applied[i]).catch(() => {})
            } else if (snap.original !== null) {
              await atomicWriteFile(applied[i], snap.original)
            }
          } catch { /* best effort rollback */ }
        }
        return `error: failed at ${applied.length + 1}/${resolved.length} — all changes rolled back. Cause: ${error.message}`
      }

      // Phase 3: summarize
      const summary = resolved.map(c => `  ${c.isCreate ? "+" : "~"} ${c.path}`).join("\n")
      return {
        output: `${resolved.length} file(s) updated atomically:\n${summary}`,
        metadata: {
          fileChanges: resolved.map(c => ({
            path: String(c.path || c.target),
            tool: "multiedit",
            stageId: ctx.stageId || null,
            taskId: ctx.logicalTaskId || ctx.taskId || null
          }))
        }
      }
    }
  }

  const enterPlanTool = {
    name: "enter_plan",
    description: "Enter planning mode. Use this PROACTIVELY when the task is non-trivial and requires architectural decisions, multi-file changes, or when multiple valid approaches exist. After calling this, outline your plan, then call `exit_plan` to present it to the user for approval.",
    inputSchema: {
      type: "object",
      properties: {
        reason: schema("string", "why planning is needed (shown to user)")
      },
      required: []
    },
    async execute(args, ctx) {
      ctx._planMode = true
      return `Planning mode entered. Outline your plan now, then call exit_plan to present it for user approval.${args.reason ? ` Reason: ${args.reason}` : ""}`
    }
  }

  const exitPlanTool = {
    name: "exit_plan",
    description: "Present your plan to the user for approval. The user will see the plan and can approve, reject, or request changes. Only call this after enter_plan and after you have outlined a complete plan in your response.",
    inputSchema: {
      type: "object",
      properties: {
        plan: schema("string", "the complete plan text to present to the user"),
        files: {
          type: "array", items: { type: "string" },
          description: "list of files that will be created or modified"
        }
      },
      required: ["plan"]
    },
    async execute(args, ctx) {
      ctx._planMode = false
      return {
        output: "Plan submitted for user approval.",
        metadata: {
          planApproval: true,
          plan: String(args.plan || ""),
          files: Array.isArray(args.files) ? args.files : []
        }
      }
    }
  }

  const notebookeditTool = {
    name: "notebookedit",
    description: "Edit a Jupyter notebook (.ipynb) cell. Supports replace, insert, and delete operations on individual cells. Use this instead of `write` when modifying notebooks — it preserves cell metadata and outputs.",
    inputSchema: {
      type: "object",
      properties: {
        path: schema("string", "notebook file path (.ipynb)"),
        cell_number: schema("number", "0-indexed cell number to operate on (default: 0)"),
        new_source: schema("string", "new cell source content"),
        cell_type: { type: "string", enum: ["code", "markdown"], description: "cell type (required for insert)" },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "operation type (default: replace)" }
      },
      required: ["path", "new_source"]
    },
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path)
      const raw = await readFile(target, "utf8")
      const notebook = JSON.parse(raw)
      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return "error: not a valid .ipynb file (missing cells array)"
      }
      const mode = args.edit_mode || "replace"
      const cellNum = Number(args.cell_number ?? 0)
      const source = String(args.new_source ?? "")
      const sourceLines = source.split("\n").map((line, i, arr) => i < arr.length - 1 ? line + "\n" : line)

      if (mode === "insert") {
        const cellType = args.cell_type
        if (!cellType || !["code", "markdown"].includes(cellType)) {
          return "error: cell_type is required for insert mode (must be 'code' or 'markdown')"
        }
        const newCell = {
          cell_type: cellType,
          metadata: {},
          source: sourceLines
        }
        if (cellType === "code") {
          newCell.execution_count = null
          newCell.outputs = []
        }
        const insertAt = cellNum < 0 ? 0 : Math.min(cellNum + 1, notebook.cells.length)
        notebook.cells.splice(insertAt, 0, newCell)
      } else if (mode === "delete") {
        if (cellNum < 0 || cellNum >= notebook.cells.length) {
          return `error: cell_number ${cellNum} out of range (0-${notebook.cells.length - 1})`
        }
        notebook.cells.splice(cellNum, 1)
      } else {
        // replace
        if (cellNum < 0 || cellNum >= notebook.cells.length) {
          return `error: cell_number ${cellNum} out of range (0-${notebook.cells.length - 1})`
        }
        const cell = notebook.cells[cellNum]
        cell.source = sourceLines
        if (args.cell_type && args.cell_type !== cell.cell_type) {
          cell.cell_type = args.cell_type
          if (args.cell_type === "markdown") {
            delete cell.execution_count
            delete cell.outputs
          } else if (args.cell_type === "code") {
            cell.execution_count = null
            cell.outputs = []
          }
        }
      }

      await atomicWriteFile(target, JSON.stringify(notebook, null, 1) + "\n")
      markFileRead(target)
      const actionLabel = mode === "insert" ? "inserted" : mode === "delete" ? "deleted" : "replaced"
      return {
        output: `${actionLabel} cell ${cellNum} in ${args.path} (${notebook.cells.length} cells total)`,
        metadata: {
          fileChanges: [{
            path: String(args.path || target),
            tool: "notebookedit",
            stageId: ctx.stageId || null,
            taskId: ctx.logicalTaskId || ctx.taskId || null
          }]
        }
      }
    }
  }

  return [listTool, readTool, writeTool, editTool, multieditTool, globTool, grepTool, bashTool, createTaskTool(), outputTool, cancelTool, todowriteTool, questionTool, skillTool, webfetchTool, websearchTool, codesearchTool, notebookeditTool, enterPlanTool, exitPlanTool]
}

function mcpTools() {
  return McpRegistry.listTools().map((tool) => ({
    name: tool.id,
    description: `[mcp:${tool.server}] ${tool.description}`,
    inputSchema: tool.inputSchema,
    async execute(args, ctx) {
      const result = await McpRegistry.callTool(tool.id, args || {}, ctx.signal || null)
      return result.output
    }
  }))
}

function toolAllowedByMode(toolName, mode) {
  if (mode === "ask" || mode === "plan") {
    return !["write", "edit", "bash", "task"].includes(toolName)
  }
  return true
}

export const ToolRegistry = {
  async initialize({ config = {}, cwd = process.cwd(), force = false } = {}) {
    const ttlMs = Math.max(0, Number(config.runtime?.tool_registry_cache_ttl_ms || 30000))
    const sig = signatureFor(config, cwd)
    const cacheValid =
      state.initialized &&
      !force &&
      state.lastSignature === sig &&
      state.lastCwd === cwd &&
      Date.now() - state.loadedAt <= ttlMs
    if (cacheValid) return

    const tools = []

    if (config.tool?.sources?.builtin !== false) {
      tools.push(...builtinTools())
    }

    if (config.tool?.sources?.local !== false) {
      const localDirs = (config.tool?.local_dirs || []).map((dir) => path.resolve(cwd, dir))
      tools.push(...(await loadDynamicTools(localDirs)))
    }

    if (config.tool?.sources?.plugin !== false) {
      const pluginDirs = (config.tool?.plugin_dirs || []).map((dir) => path.resolve(cwd, dir))
      tools.push(...(await loadDynamicTools(pluginDirs)))
    }

    if (config.tool?.sources?.mcp !== false) {
      await McpRegistry.initialize(config, { cwd })
      tools.push(...mcpTools())
    }

    state.tools = tools
    state.initialized = true
    state.loadedAt = Date.now()
    state.lastSignature = sig
    state.lastCwd = cwd
    state.lastConfig = config
  },

  isReady() {
    return state.initialized
  },

  async list({ mode, cwd = process.cwd(), config = undefined } = {}) {
    const resolvedConfig = config === undefined ? state.lastConfig || {} : config
    if (!state.initialized) {
      await this.initialize({ config: resolvedConfig, cwd })
    } else {
      await this.initialize({ config: resolvedConfig, cwd, force: false })
    }
    return state.tools
      .filter((tool) => toolAllowedByMode(tool.name, mode))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
  },

  async get(toolName) {
    return state.tools.find((tool) => tool.name === toolName) || null
  },

  async call(toolName, args, ctx) {
    const tool = await this.get(toolName)
    if (!tool) {
      return {
        name: toolName,
        status: "error",
        output: `unknown tool: ${toolName}`,
        error: `unknown tool: ${toolName}`
      }
    }
    try {
      const output = await tool.execute(args || {}, ctx)
      return {
        name: toolName,
        status: "completed",
        output: safeStringify(output)
      }
    } catch (error) {
      return {
        name: toolName,
        status: "error",
        output: error.message,
        error: error.message
      }
    }
  }
}
