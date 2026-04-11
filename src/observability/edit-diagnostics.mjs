import { access } from "node:fs/promises"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const execFile = promisify(execFileCb)

const MUTATION_TOOLS = new Set(["write", "edit", "patch", "multiedit", "notebookedit"])
const JS_SYNTAX_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"])

export const EDIT_DIAGNOSTICS_CONTRACT = "kkcode/edit-diagnostics@1"
export const MUTATION_OBSERVABILITY_CONTRACT = "kkcode/mutation-observability@1"

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))]
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function relativeFile(cwd, filePath) {
  if (!filePath) return ""
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  const relative = path.relative(cwd, absolute)
  return relative && !relative.startsWith("..") ? relative : filePath
}

function diagnosticFingerprint(diagnostic = {}) {
  return [
    diagnostic.provider || "",
    diagnostic.file || "",
    diagnostic.code || "",
    diagnostic.severity || "",
    diagnostic.line ?? "",
    diagnostic.column ?? "",
    diagnostic.message || ""
  ].join("|")
}

function normalizeDiagnostic(diagnostic = {}, cwd = process.cwd()) {
  const file = diagnostic.file ? relativeFile(cwd, diagnostic.file) : ""
  return {
    provider: String(diagnostic.provider || "unknown"),
    file,
    severity: String(diagnostic.severity || "error"),
    code: diagnostic.code ? String(diagnostic.code) : null,
    message: String(diagnostic.message || "").trim(),
    line: Number.isFinite(diagnostic.line) ? Number(diagnostic.line) : null,
    column: Number.isFinite(diagnostic.column) ? Number(diagnostic.column) : null
  }
}

function sortDiagnostics(diagnostics = []) {
  return [...diagnostics].sort((left, right) => {
    const byFile = String(left.file || "").localeCompare(String(right.file || ""))
    if (byFile !== 0) return byFile
    const byLine = Number(left.line || 0) - Number(right.line || 0)
    if (byLine !== 0) return byLine
    const byColumn = Number(left.column || 0) - Number(right.column || 0)
    if (byColumn !== 0) return byColumn
    return String(left.message || "").localeCompare(String(right.message || ""))
  })
}

function summarizeDiagnosticsDelta({ baseline = [], current = [], delta, available, reason = "" }) {
  if (!available) {
    return {
      status: "unavailable",
      text: reason ? `diagnostics unavailable (${reason})` : "diagnostics unavailable"
    }
  }

  const addedCount = delta.added.length
  const resolvedCount = delta.resolved.length
  const persistedCount = delta.persisted.length
  const currentCount = current.length
  const baselineCount = baseline.length

  if (addedCount === 0 && resolvedCount === 0 && currentCount === 0) {
    return {
      status: "clean",
      text: baselineCount === 0
        ? "clean (no diagnostics before or after)"
        : "clean (all prior diagnostics resolved)"
    }
  }

  if (addedCount > 0 && resolvedCount > 0) {
    return {
      status: "mixed",
      text: `introduced ${pluralize(addedCount, "diagnostic")}, resolved ${pluralize(resolvedCount, "diagnostic")}, ${pluralize(persistedCount, "diagnostic")} still present`
    }
  }

  if (addedCount > 0) {
    return {
      status: "regressed",
      text: `introduced ${pluralize(addedCount, "diagnostic")}; ${pluralize(persistedCount, "diagnostic")} still present`
    }
  }

  if (resolvedCount > 0) {
    return {
      status: "improved",
      text: currentCount === 0
        ? `resolved ${pluralize(resolvedCount, "diagnostic")}; workspace is clean`
        : `resolved ${pluralize(resolvedCount, "diagnostic")}; ${pluralize(currentCount, "diagnostic")} remain`
    }
  }

  return {
    status: "unchanged",
    text: currentCount === 0
      ? "clean (no diagnostics changed)"
      : `no diagnostic changes (${pluralize(currentCount, "diagnostic")} remain)`
  }
}

export function diffDiagnostics(baseline = [], current = []) {
  const baselineMap = new Map(baseline.map((item) => [diagnosticFingerprint(item), item]))
  const currentMap = new Map(current.map((item) => [diagnosticFingerprint(item), item]))

  const added = []
  const persisted = []
  const resolved = []

  for (const [key, diagnostic] of currentMap) {
    if (baselineMap.has(key)) persisted.push(diagnostic)
    else added.push(diagnostic)
  }

  for (const [key, diagnostic] of baselineMap) {
    if (!currentMap.has(key)) resolved.push(diagnostic)
  }

  return {
    added: sortDiagnostics(added),
    persisted: sortDiagnostics(persisted),
    resolved: sortDiagnostics(resolved),
    unchanged: added.length === 0 && resolved.length === 0
  }
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function createProviderStatus({ name, available, checkedFiles = [], diagnostics = [], reason = "" }) {
  return {
    name,
    available,
    checkedFiles: uniq(checkedFiles),
    diagnostics: diagnostics.length,
    ...(reason ? { reason } : {})
  }
}

async function collectNodeSyntaxDiagnostics({ cwd, files }) {
  const checkedFiles = uniq(files.filter((file) => JS_SYNTAX_EXTENSIONS.has(path.extname(file).toLowerCase())))
  if (checkedFiles.length === 0) {
    return {
      diagnostics: [],
      providers: [createProviderStatus({ name: "node-syntax", available: false, reason: "no JavaScript syntax-checkable files" })]
    }
  }

  const diagnostics = []
  for (const file of checkedFiles) {
    const absolute = path.resolve(cwd, file)
    try {
      await execFile(process.execPath, ["--check", absolute], {
        cwd,
        timeout: 15000,
        encoding: "utf8"
      })
    } catch (error) {
      const output = String(error?.stderr || error?.stdout || error?.message || "").trim()
      const lineMatch = output.match(/:(\d+)\s*\n/) || output.match(/:(\d+)\s*$/m)
      diagnostics.push(normalizeDiagnostic({
        provider: "node-syntax",
        file,
        severity: "error",
        code: "node-check",
        message: output || "JavaScript syntax error",
        line: lineMatch ? Number(lineMatch[1]) : null,
        column: null
      }, cwd))
    }
  }

  return {
    diagnostics,
    providers: [createProviderStatus({
      name: "node-syntax",
      available: true,
      checkedFiles,
      diagnostics
    })]
  }
}

function parseTypeScriptDiagnostics(output, cwd) {
  const diagnostics = []
  const lines = String(output || "").split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^(.*)\((\d+),(\d+)\): error (TS\d+): (.+)$/)
      || line.match(/^(.*):(\d+):(\d+) - error (TS\d+): (.+)$/)
    if (!match) continue
    diagnostics.push(normalizeDiagnostic({
      provider: "typescript-project",
      file: match[1],
      severity: "error",
      code: match[4],
      message: match[5],
      line: Number(match[2]),
      column: Number(match[3])
    }, cwd))
  }
  return diagnostics
}

async function collectTypeScriptDiagnostics({ cwd, files }) {
  const checkedFiles = uniq(files.filter((file) => TS_EXTENSIONS.has(path.extname(file).toLowerCase())))
  if (checkedFiles.length === 0) {
    return {
      diagnostics: [],
      providers: [createProviderStatus({ name: "typescript-project", available: false, reason: "no TypeScript files in edit set" })]
    }
  }

  const tsconfigPath = path.join(cwd, "tsconfig.json")
  if (!(await exists(tsconfigPath))) {
    return {
      diagnostics: [],
      providers: [createProviderStatus({ name: "typescript-project", available: false, checkedFiles, reason: "missing tsconfig.json" })]
    }
  }

  try {
    await execFile("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd,
      timeout: 20000,
      encoding: "utf8"
    })
    return {
      diagnostics: [],
      providers: [createProviderStatus({ name: "typescript-project", available: true, checkedFiles, diagnostics: [] })]
    }
  } catch (error) {
    const output = String(error?.stdout || error?.stderr || error?.message || "").trim()
    const diagnostics = parseTypeScriptDiagnostics(output, cwd)
    return {
      diagnostics,
      providers: [createProviderStatus({
        name: "typescript-project",
        available: true,
        checkedFiles,
        diagnostics,
        reason: diagnostics.length === 0 ? "typecheck failed without parseable diagnostics" : ""
      })]
    }
  }
}

export async function collectDiagnosticsSnapshot({ cwd = process.cwd(), files = [] } = {}) {
  const normalizedFiles = uniq(files.map((file) => relativeFile(cwd, file)))
  const nodeSyntax = await collectNodeSyntaxDiagnostics({ cwd, files: normalizedFiles })
  const typescript = await collectTypeScriptDiagnostics({ cwd, files: normalizedFiles })
  const diagnostics = sortDiagnostics([
    ...toArray(nodeSyntax.diagnostics),
    ...toArray(typescript.diagnostics)
  ])
  const providers = [...toArray(nodeSyntax.providers), ...toArray(typescript.providers)]
  const available = providers.some((provider) => provider.available)

  return {
    files: normalizedFiles,
    diagnostics,
    providers,
    available
  }
}

export function buildEditDiagnosticsReport({ cwd = process.cwd(), files = [], baseline = {}, current = {}, reason = "" } = {}) {
  const baselineDiagnostics = sortDiagnostics(toArray(baseline.diagnostics || []).map((item) => normalizeDiagnostic(item, cwd)))
  const currentDiagnostics = sortDiagnostics(toArray(current.diagnostics || []).map((item) => normalizeDiagnostic(item, cwd)))
  const delta = diffDiagnostics(baselineDiagnostics, currentDiagnostics)
  const available = Boolean(baseline.available || current.available || baselineDiagnostics.length || currentDiagnostics.length)
  const summary = summarizeDiagnosticsDelta({
    baseline: baselineDiagnostics,
    current: currentDiagnostics,
    delta,
    available,
    reason
  })

  return {
    contract: EDIT_DIAGNOSTICS_CONTRACT,
    files: uniq(files.map((file) => relativeFile(cwd, file))),
    available,
    baseline: {
      count: baselineDiagnostics.length,
      diagnostics: baselineDiagnostics,
      providers: toArray(baseline.providers)
    },
    current: {
      count: currentDiagnostics.length,
      diagnostics: currentDiagnostics,
      providers: toArray(current.providers)
    },
    delta,
    summary
  }
}

function normalizeMutationChanges(metadata = {}) {
  if (metadata?.observability?.contract === MUTATION_OBSERVABILITY_CONTRACT) {
    return toArray(metadata.observability.changes)
  }

  const fromMutations = toArray(metadata.mutations).map((item) => ({
    path: String(item?.filePath || item?.path || "").trim(),
    operation: String(item?.operation || "multiedit"),
    addedLines: Math.max(0, Number(item?.addedLines || 0)),
    removedLines: Math.max(0, Number(item?.removedLines || 0))
  }))

  const fromMutation = metadata.mutation
    ? [{
        path: String(metadata.mutation.filePath || metadata.mutation.path || "").trim(),
        operation: String(metadata.mutation.operation || "mutation"),
        addedLines: Math.max(0, Number(metadata.mutation.addedLines || 0)),
        removedLines: Math.max(0, Number(metadata.mutation.removedLines || 0))
      }]
    : []

  const fromFileChanges = toArray(metadata.fileChanges).map((item) => ({
    path: String(item?.path || "").trim(),
    operation: String(item?.tool || item?.operation || "mutation"),
    addedLines: Math.max(0, Number(item?.addedLines || 0)),
    removedLines: Math.max(0, Number(item?.removedLines || 0))
  }))

  return uniq([...fromMutations, ...fromMutation, ...fromFileChanges]
    .filter((item) => item.path)
    .map((item) => JSON.stringify(item))).map((item) => JSON.parse(item))
}

export function buildMutationObservability(metadata = {}) {
  const changes = normalizeMutationChanges(metadata)
  if (changes.length === 0) {
    return {
      contract: MUTATION_OBSERVABILITY_CONTRACT,
      changes: [],
      totals: {
        filesChanged: 0,
        addedLines: 0,
        removedLines: 0
      },
      operations: [],
      summary: "no file mutations recorded"
    }
  }

  const totals = changes.reduce((acc, item) => ({
    filesChanged: acc.filesChanged + 1,
    addedLines: acc.addedLines + Math.max(0, Number(item.addedLines || 0)),
    removedLines: acc.removedLines + Math.max(0, Number(item.removedLines || 0))
  }), { filesChanged: 0, addedLines: 0, removedLines: 0 })
  const operations = uniq(changes.map((item) => item.operation))
  const operationText = operations.length === 1
    ? `via ${operations[0]}`
    : `across ${pluralize(operations.length, "operation")}`
  const summary = `${pluralize(totals.filesChanged, "file")} changed ${operationText} (+${totals.addedLines}/-${totals.removedLines})`

  return {
    contract: MUTATION_OBSERVABILITY_CONTRACT,
    changes,
    totals,
    operations,
    summary
  }
}

export function extractTouchedFiles({ args = {}, metadata = {} } = {}) {
  const files = []
  if (args?.path) files.push(String(args.path))
  for (const change of toArray(args?.changes)) {
    if (change?.path) files.push(String(change.path))
  }
  for (const change of toArray(metadata?.fileChanges)) {
    if (change?.path) files.push(String(change.path))
  }
  if (metadata?.mutation?.filePath) files.push(String(metadata.mutation.filePath))
  for (const change of toArray(metadata?.mutations)) {
    if (change?.filePath) files.push(String(change.filePath))
  }
  return uniq(files)
}

export function isMutationTool(toolName) {
  return MUTATION_TOOLS.has(String(toolName || ""))
}

export function isDiagnosticsEligibleFile(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase()
  return JS_SYNTAX_EXTENSIONS.has(extension) || TS_EXTENSIONS.has(extension)
}

export function extractEditFeedbackFromToolEvents(toolEvents = []) {
  return toArray(toolEvents)
    .filter((event) => isMutationTool(event?.name))
    .map((event) => {
      const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {}
      const observability = metadata.observability?.contract === MUTATION_OBSERVABILITY_CONTRACT
        ? metadata.observability
        : buildMutationObservability(metadata)
      const diagnostics = metadata.diagnostics?.contract === EDIT_DIAGNOSTICS_CONTRACT
        ? metadata.diagnostics
        : null
      const files = uniq([
        ...extractTouchedFiles({ args: event?.args, metadata }),
        ...toArray(observability?.changes).map((item) => item.path),
        ...toArray(diagnostics?.files)
      ])

      if (!observability.changes.length && !diagnostics) return null

      return {
        tool: String(event?.name || ""),
        status: String(event?.status || ""),
        files,
        observability,
        diagnostics
      }
    })
    .filter(Boolean)
}
