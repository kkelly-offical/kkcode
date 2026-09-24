import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, lstat, realpath, rm } from "node:fs/promises"
import { userRootDir } from "../../storage/paths.mjs"
import { createDockerExecutionBackend, runStrictCommand } from "../isolation/docker-executor.mjs"
import { archiveBinaryArtifact, authorizeArtifactAccess } from "../tool/artifacts.mjs"

const services = new WeakSet()
const formats = new Set([".docx", ".xlsx", ".pptx", ".pdf", ".md", ".png", ".jpg", ".jpeg"])
const operations = new Set(["capabilities", "inspect", "create", "edit", "render", "merge_pdf", "select_pdf_pages", "fill_pdf", "annotate_pdf", "ocr"])
const requestKeys = new Set(["operation", "inputs", "outputDir", "filename", "format", "spec", "changes", "pages", "fields", "annotations", "language"])
const fieldsByOperation = {
  capabilities: [], inspect: ["inputs"], create: ["inputs", "outputDir", "filename", "format", "spec"],
  edit: ["inputs", "outputDir", "filename", "changes"], render: ["inputs", "outputDir"],
  merge_pdf: ["inputs", "outputDir", "filename"], select_pdf_pages: ["inputs", "outputDir", "filename", "pages"],
  fill_pdf: ["inputs", "outputDir", "filename", "fields"], annotate_pdf: ["inputs", "outputDir", "filename", "annotations"],
  ocr: ["inputs", "outputDir", "filename", "language"]
}
const privateNames = new Set([".git", ".kkcode", ".ssh", ".aws", ".azure", ".kube", ".gnupg"])
const limits = { cpus: 2, memory_mb: 2048, pids: 256, tmp_mb: 1024, max_output_bytes: 4 * 1024 * 1024, timeout_ms: 240000 }
const MIME = { ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pdf": "application/pdf", ".md": "text/markdown", ".png": "image/png", ".txt": "text/plain", ".tsv": "text/tab-separated-values" }

export class OfficeError extends Error {
  constructor(code, message, details = null) { super(message); this.name = "OfficeError"; this.code = code; this.details = details }
}
const fail = (code, message, details) => { throw new OfficeError(code, message, details) }

function localName(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).some(part => !part || part === "." || part === ".." || privateNames.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))) {
    fail("office_scope", "文档路径必须位于当前工作目录，不能访问私密配置或治理目录。")
  }
  return value
}

function receipt(result, action) {
  if (result.cancelled || result.timedOut || result.overflow || result.exitCode !== 0) fail("office_execution", `隔离文档${action}进程未完整结束；未将部分输出标记为完成。`)
  let value
  try { value = JSON.parse(result.stdout) } catch { fail("office_receipt", "文档工具未返回合法回执。") }
  if (!value?.ok) fail(value?.error?.code || "office_execution", value?.error?.message || "文档处理失败。", value?.error?.details)
  return value
}

/** Fixed transfer helpers alone mount the workspace. Document parsers only see
 * their fresh offline job. Image selection is host configuration, not tool args.
 * @param {{cwd: string, image: string}} options
 */
export async function createOfficeService({ cwd, image }) {
  const root = await realpath(cwd)
  if (!/^sha256:[a-f0-9]{64}$/.test(image || "") && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image || "")) fail("office_unavailable", "文档工具需要宿主配置经过验收的固定镜像摘要；不会自动下载或使用浮动标签。")
  let closed = false, chain = Promise.resolve()
  const service = {
    cwd: root, strict: true,
    capabilities(options = {}) { return service.run({ operation: "capabilities" }, options) },
    run(request, { signal = null, onOutput = null } = {}) {
      const work = chain.then(async () => {
        if (closed) fail("office_closed", "文档服务已经关闭。")
        signal?.throwIfAborted()
        if (onOutput !== null && typeof onOutput !== "function") fail("office_input", "文档归档必须由宿主提供受控回调。")
        if (!request || typeof request !== "object" || Array.isArray(request) || !operations.has(request.operation)
          || Object.keys(request).some(key => !requestKeys.has(key)) || Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) fail("office_input", "文档操作无效、包含未知参数或请求超过 2 MiB。")
        if (Object.keys(request).some(key => key !== "operation" && !fieldsByOperation[request.operation].includes(key))) fail("office_input", "此文档操作包含不适用的参数，请按对应操作的说明填写。")
        const inputNames = request.inputs || []
        if (!Array.isArray(inputNames) || inputNames.length > 30) fail("office_input", "一次最多处理 30 个输入文件。")
        if (!["capabilities", "create"].includes(request.operation) && !inputNames.length) fail("office_input", "此文档操作至少需要一个输入文件。")
        for (const name of inputNames) {
          localName(name)
          if (!formats.has(path.extname(name).toLowerCase())) fail("office_unsupported", "仅支持 DOCX/XLSX/PPTX/PDF/Markdown 和 PNG/JPEG 图片输入。")
        }
        const id = randomUUID(), parent = path.join(userRootDir(), "office-jobs")
        const relativeDir = ["capabilities", "inspect"].includes(request.operation) ? null : localName(request.outputDir || `kkcode-documents/${id}`)
        await mkdir(parent, { recursive: true, mode: 0o700 })
        if ((await lstat(parent)).isSymbolicLink()) fail("office_scope", "文档临时目录不能是符号链接。")
        const job = await mkdtemp(path.join(await realpath(parent), "job-"))
        const identity = await lstat(job)
        try {
          await mkdir(path.join(job, "inputs"), { mode: 0o700 })
          const backend = createDockerExecutionBackend({ image, limits, readOnlyPaths: ["inputs"] })
          const isolation = await backend.ensureReady({ cwd: job, contract: { allowedPaths: ["."] }, signal })
          const transfer = async (payload, { writeWorkspace = false, writeJob = false } = {}) => receipt(await runStrictCommand({
            image: isolation.imageId, workspaceDir: root, transferDir: job, transferReadOnly: !writeJob, readOnly: !writeWorkspace,
            limits, signal, timeoutMs: 120000, argv: ["/opt/office-venv/bin/python", "/opt/kkcode-office/transfer.py"], stdin: JSON.stringify(payload)
          }), "文件搬运")
          const collected = request.operation === "capabilities" ? { inputs: [] }
            : await transfer({ operation: "collect", inputs: inputNames, outputDir: relativeDir }, { writeJob: true })
          const publicProvenance = collected.inputs.map(({ mapped: _mapped, ...item }) => item)
          const { outputDir: _outputDir, ...payload } = request
          const result = await runStrictCommand({ image: isolation.imageId, workspaceDir: job, limits, signal, timeoutMs: 240000,
            argv: ["/opt/office-venv/bin/python", "/opt/kkcode-office/worker.py"],
            stdin: JSON.stringify({ ...payload, inputs: collected.inputs.map(item => item.mapped) }), readOnlyPaths: ["inputs"] })
          const value = receipt(result, "处理")
          if (!value.outputs) {
            if (publicProvenance.length) await transfer({ operation: "verify", inputs: publicProvenance })
            return { ...value, inputs: publicProvenance, isolation: { backend: "docker", imageId: isolation.imageId, network: "none", fileTransfer: "isolated-dirfd" } }
          }
          if (!Array.isArray(value.outputs) || !value.outputs.length || value.outputs.length > 200) fail("office_receipt", "文档工具输出清单无效。")
          await transfer({ operation: "publish", outputDir: relativeDir, outputs: value.outputs, primary: value.primary, inputs: publicProvenance }, { writeWorkspace: true })
          if (onOutput && value.outputs.reduce((sum, item) => sum + item.bytes, 0) > 128 * 1024 * 1024) {
            fail("office_archive_limit", "文档已交付，但本次归档产物总量超过 128 MiB；请检查输出目录并缩小文档或预览范围。", { inspectOutputDir: relativeDir })
          }
          const outputs = []
          for (const output of value.outputs) {
            const item = { ...output, path: path.join(relativeDir, output.name).split(path.sep).join("/"), mime: MIME[path.extname(output.name).toLowerCase()] || "application/octet-stream" }
            if (onOutput) {
              let consumed = false
              const content = (async function* () {
                const hash = createHash("sha256")
                let offset = 0
                while (offset < item.bytes) {
                  const chunk = receipt(await runStrictCommand({ image: isolation.imageId, workspaceDir: job, readOnly: true,
                    limits: { ...limits, max_output_bytes: 24 * 1024 * 1024 }, signal, timeoutMs: 120000,
                    argv: ["/opt/office-venv/bin/python", "/opt/kkcode-office/transfer.py"],
                    stdin: JSON.stringify({ operation: "export", name: item.name, offset, limit: 8 * 1024 * 1024 }) }), "归档")
                  if (chunk.offset !== offset || chunk.totalSize !== item.bytes || typeof chunk.data !== "string") fail("office_receipt", "文档归档分块与回执不一致。")
                  const bytes = Buffer.from(chunk.data, "base64")
                  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || offset + bytes.length > item.bytes) fail("office_receipt", "文档归档分块大小无效。")
                  hash.update(bytes); offset += bytes.length
                  yield bytes
                }
                if (hash.digest("hex") !== item.sha256) fail("office_receipt", "文档完整归档指纹与已验收输出不同。")
                consumed = true
              })()
              try {
                item.artifactRef = await onOutput({ output: Object.freeze({ ...item }), content, signal })
                if (!consumed) fail("office_receipt", "受控归档没有完整读取文档。")
              }
              catch (error) { throw new OfficeError(error.code || "office_archive", "文档已经交付到新目录，但受控归档未全部完成；请检查输出目录和存储配额。", { inspectOutputDir: relativeDir }) }
            }
            outputs.push(item)
          }
          return { ok: true, primary: path.join(relativeDir, value.primary).split(path.sep).join("/"),
            outputs,
            validation: value.validation, inputs: publicProvenance,
            isolation: { backend: "docker", imageId: isolation.imageId, network: "none", fileTransfer: "isolated-dirfd" } }
        } catch (error) {
          if (error.code === "EEXIST") fail("office_conflict", "输出目录已经存在；请选择新目录，原有文件不会被覆盖。")
          const failure = ["ELOOP", "ENOTDIR"].includes(error.code)
            ? new OfficeError("office_scope", "文档路径包含符号链接或父目录在处理期间发生变化，已停止读取或交付。") : error
          throw failure
        } finally {
          const current = await lstat(job).catch(() => null)
          if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await rm(job, { recursive: true, force: false })
        }
      })
      chain = work.catch(() => {})
      return work
    },
    async dispose() { closed = true; await chain }
  }
  services.add(service)
  return Object.freeze(service)
}

export function isOfficeService(service) { return services.has(service) }

export function createOfficeTools() {
  const definitions = [
    ["office_capabilities", "capabilities", "Check the host-approved offline document image, installed versions, OCR languages and supported limits."],
    ["office_inspect", "inspect", "Read supported Office/PDF/Markdown inputs without executing macros. Refuse encrypted or unsupported active objects; report complete structured text."],
    ["office_create", "create", "Create DOCX/XLSX/PPTX/PDF/Markdown as NEW files. Render Office/PDF pages, verify text and recalculate explicit spreadsheet formulas; never overwrite originals."],
    ["office_edit", "edit", "Edit unique text runs or selected cells into a NEW document directory, preserving originals. Unsupported complex objects are rejected, not silently discarded."],
    ["office_render", "render", "Actually render supported documents to PDF and PNG page previews. Rendering evidence is not a claim of flawless visual design."],
    ["office_pdf", null, "Merge/select PDF pages, fill existing AcroForm text fields, or add clickable text notes into a NEW file. Digital signatures, encryption and active content are rejected."],
    ["office_ocr", "ocr", "OCR selected PDF/PNG/JPEG inputs in the offline image. Report confidence and require review; OCR is not authoritative source text."]
  ]
  const tools = definitions.map(([name, operation, description]) => ({
    name, description, group: "documents", readOnly: ["capabilities", "inspect"].includes(operation),
    inputSchema: { type: "object", properties: /** @type {Record<string, any>} */ ({
      inputs: { type: "array", items: { type: "string" }, maxItems: 30, description: "Workspace-relative input paths; first is the document for inspect/edit/render/OCR." },
      outputDir: { type: "string", description: "New workspace-relative output directory; existing directories are never replaced." },
      filename: { type: "string", description: "Output basename including format extension." },
      format: { type: "string", enum: ["docx", "xlsx", "pptx", "pdf", "md"] },
      spec: { type: "object", description: "DOCX/PDF: title and blocks(paragraph/heading/table/image). XLSX: sheets(name,rows,chart). PPTX: slides(title,body,image,chart). MD: text. Formula cells require {formula:'=SUM(A1:A2)'}; ordinary strings stay text." },
      changes: { type: "object", description: "DOCX/PPTX/MD: replace:[{find,replace}] unique text run; XLSX: cells:[{sheet,cell,value}]." },
      operation: { type: "string", enum: ["merge_pdf", "select_pdf_pages", "fill_pdf", "annotate_pdf"] },
      pages: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 40 },
      fields: { type: "object", description: "Existing AcroForm text field names mapped to replacement strings; no XFA, signatures or scripts." },
      annotations: { type: "array", maxItems: 100, items: { type: "object", properties: { page: { type: "integer", minimum: 1 }, rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, text: { type: "string" } }, required: ["page", "rect", "text"], additionalProperties: false } },
      language: { type: "string", enum: ["eng", "chi_sim", "eng+chi_sim"] }
    }), additionalProperties: false, required: [] },
    async execute(args, ctx = {}) {
      if (!isOfficeService(ctx.officeService)) return { status: "error", output: "文档工具尚未配置经过验收的隔离镜像，请由宿主在高级配置中启用。" }
      try {
        const selected = operation || args.operation
        const archive = !["capabilities", "inspect"].includes(selected)
        if (archive) await authorizeArtifactAccess(ctx.artifactAccess)
        const result = await ctx.officeService.run({ ...args, operation: selected }, { signal: ctx.signal,
          onOutput: archive ? ({ output, content, signal }) => archiveBinaryArtifact({ access: ctx.artifactAccess, content, mime: output.mime,
            callId: ctx.toolCallId, kind: "document", maxBytes: 128 * 1024 * 1024, signal }) : null })
        return { status: "completed", output: JSON.stringify(result), metadata: { office: result, outputComplete: true,
          artifactRefs: (result.outputs || []).map(output => output.artifactRef).filter(Boolean) } }
      } catch (error) {
        return { status: "error", output: error.message, metadata: { officeError: { code: error.code || "office_execution", details: error.details || null } } }
      }
    }
  }))
  for (const [index, tool] of tools.entries()) {
    const operation = definitions[index][1]
    const included = operation ? fieldsByOperation[operation] : ["operation", "inputs", "outputDir", "filename", "pages", "fields", "annotations"]
    tool.inputSchema.properties = Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([name]) => included.includes(name)))
    tool.inputSchema.required = operation === "capabilities" ? [] : operation === "create" ? ["format", "spec"]
      : operation === "edit" ? ["inputs", "changes"] : operation ? ["inputs"] : ["operation", "inputs"]
  }
  return tools
}
