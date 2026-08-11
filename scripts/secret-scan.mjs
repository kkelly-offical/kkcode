import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 模式刻意写成「前缀 + 字符类」的形态：字符类的 `[` 使正则源码不会匹配
// 自身（本脚本也在扫描范围内）。新增模式沿用同一写法。
export const SECRET_PATTERNS = [
  ["Kimi API key", /sk-kimi-[A-Za-z0-9]{20,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ["GitHub fine-grained PAT", /github_pat_[A-Za-z0-9]{22,}[A-Za-z0-9_]*/g],
  ["npm access token", /npm_[A-Za-z0-9]{36,}/g],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9]{2,}-[A-Za-z0-9_-]{20,}/g],
  ["OpenAI project key", /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ["Google API key", /AIza[A-Za-z0-9_-]{35}/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
]

export function findSecretsInText(source) {
  const findings = []
  const text = String(source || "")
  for (const [label, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      findings.push({ label, index: match.index, line: text.slice(0, match.index).split("\n").length })
    }
  }
  return findings
}

function displayPath(file) {
  // Git 路径可含换行和 ESC/OSC 控制序列。日志里必须以转义文本
  // 展示，否则一个恶意文件名就能清屏或触发终端剪贴板。
  let safe = String(file)
  for (const [, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    safe = safe.replace(pattern, "<redacted>")
  }
  return JSON.stringify(safe).slice(1, -1).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff]/giu,
    (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`
  )
}

function nulRecords(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean)
}

function indexEntries(cwd) {
  const records = nulRecords(execFileSync("git", ["ls-files", "-z", "--stage"], { cwd }))
  return records.flatMap((record) => {
    const separator = record.indexOf("\t")
    if (separator < 0) return []
    const [mode, objectId, stage] = record.slice(0, separator).split(/\s+/)
    return [{ mode, objectId, stage, file: record.slice(separator + 1) }]
  })
}

function sparseWorktreePaths(cwd) {
  const records = nulRecords(execFileSync("git", ["ls-files", "-z", "-v"], { cwd }))
  return new Set(records
    .filter((record) => record.startsWith("S "))
    .map((record) => record.slice(2)))
}

const NPM_PACK_ARGS = ["pack", "--dry-run", "--json", "--ignore-scripts"]

/**
 * Resolve npm without trying to execute npm.cmd directly. Node cannot launch
 * .cmd files through execFile on Windows, so npm's JS entrypoint is preferred
 * and cmd.exe is the controlled fallback.
 */
export function npmPackInvocation({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath
} = {}) {
  const npmExecPath = String(env.npm_execpath || "")
  if (/\.[cm]?js$/iu.test(npmExecPath)) {
    return { command: execPath, args: [npmExecPath, ...NPM_PACK_ARGS] }
  }
  if (platform === "win32") {
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", `npm.cmd ${NPM_PACK_ARGS.join(" ")}`]
    }
  }
  return { command: "npm", args: NPM_PACK_ARGS }
}

export function parseNpmPackManifest(output) {
  const parsed = JSON.parse(String(output || ""))
  if (!Array.isArray(parsed) || parsed.length === 0) {
    const error = new Error("invalid npm pack manifest")
    error.code = "INVALID_PACK_MANIFEST"
    throw error
  }

  const files = []
  for (const entry of parsed) {
    if (!Array.isArray(entry?.files) || entry.files.length === 0) {
      const error = new Error("invalid npm pack manifest")
      error.code = "INVALID_PACK_MANIFEST"
      throw error
    }
    for (const file of entry.files) {
      if (typeof file?.path !== "string" || file.path.length === 0) {
        const error = new Error("invalid npm pack manifest")
        error.code = "INVALID_PACK_MANIFEST"
        throw error
      }
      files.push(file.path)
    }
  }
  return [...new Set(files)]
}

export function npmPackFiles(cwd, options = {}) {
  if (!existsSync(path.join(cwd, "package.json"))) return { files: [], error: null }
  const invocation = npmPackInvocation(options)
  const execute = options.execFileSync || execFileSync
  try {
    const output = execute(invocation.command, invocation.args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    })
    return { files: parseNpmPackManifest(output), error: null }
  } catch (error) {
    // npm 的 error.message 可能带 stderr 或恶意 package 名，发布日志只报类型。
    return { files: [], error: error?.code || "pack error" }
  }
}

function appendSecretFindings(findings, file, source, suffix = "") {
  for (const finding of findSecretsInText(source)) {
    findings.push(`${displayPath(file)}${suffix}:${finding.line}: possible ${finding.label}`)
  }
}

/** Scan an unpacked package tree without following symlinks. */
export function scanDirectoryTree(root) {
  const findings = []
  const files = []
  let scanned = 0

  function walk(directory, relativeDirectory = "") {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      findings.push(`${displayPath(relativeDirectory || ".")}: possible unreadable directory (${error?.code || "read error"})`)
      return
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      const fullPath = path.join(directory, entry.name)
      for (const finding of findSecretsInText(entry.name)) {
        findings.push(`${displayPath(relativePath)}: possible ${finding.label} in filename`)
      }

      let stat
      try {
        stat = lstatSync(fullPath)
      } catch (error) {
        findings.push(`${displayPath(relativePath)}: possible unreadable file (${error?.code || "read error"})`)
        continue
      }
      if (stat.isDirectory()) {
        walk(fullPath, relativePath)
        continue
      }

      let source
      try {
        if (stat.isSymbolicLink()) source = readlinkSync(fullPath, "utf8")
        else if (stat.isFile()) source = readFileSync(fullPath, "utf8")
        else {
          findings.push(`${displayPath(relativePath)}: possible unreadable file (unsupported file type)`)
          continue
        }
      } catch (error) {
        findings.push(`${displayPath(relativePath)}: possible unreadable file (${error?.code || "read error"})`)
        continue
      }
      files.push(relativePath)
      scanned++
      appendSecretFindings(findings, relativePath, source)
    }
  }

  walk(path.resolve(root))
  return { files, scanned, findings }
}

export function scanRepository(cwd = process.cwd()) {
  // -z 是正确性要求：Git 允许文件名带换行，按 \n 切会把一个文件拆成两个并静默漏扫。
  const listed = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd })
  const gitFiles = nulRecords(listed)
  const pack = npmPackFiles(cwd)
  const packFileSet = new Set(pack.files)
  const files = [...new Set([...gitFiles, ...pack.files])]
  const staged = indexEntries(cwd)
  const gitlinks = new Set(staged.filter((entry) => entry.mode === "160000").map((entry) => entry.file))
  const sparsePaths = sparseWorktreePaths(cwd)
  const findings = []
  if (pack.error) findings.push(`package.json: possible unscanned npm payload (${pack.error})`)
  const worktreeSources = new Map()
  let scanned = 0
  for (const file of files) {
    const filenameSecrets = findSecretsInText(file)
    for (const finding of filenameSecrets) {
      findings.push(`${displayPath(file)}: possible ${finding.label} in filename`)
    }
    // gitlink 的目录内容属于另一个仓库，不是当前发布对象。
    // 但若 npm pack 明确把该路径纳入 payload，就不能借 gitlink 身份跳过。
    if (gitlinks.has(file) && !packFileSet.has(file)) continue
    let source
    try {
      const fullPath = path.join(cwd, file)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) source = readlinkSync(fullPath, "utf8")
      else if (stat.isFile()) source = readFileSync(fullPath, "utf8")
      else {
        findings.push(`${displayPath(file)}: possible unreadable file (unsupported file type)`)
        continue
      }
      scanned++
    } catch (error) {
      // sparse checkout 未展开的路径会在下方直接扫描 index blob；
      // 普通 tracked 文件被删除则仍 fail closed。
      if (error?.code === "ENOENT" && sparsePaths.has(file)) continue
      // 发布门槛不能把「没扫到」当成「没有密钥」。
      findings.push(`${displayPath(file)}: possible unreadable file (${error?.code || "read error"})`)
      continue
    }
    worktreeSources.set(file, source)
    appendSecretFindings(findings, file, source)
  }

  // 发布对象由 index/commit 内容产生。只扫 worktree 会漏掉「已暂存
  // secret，随后又把工作树改干净」的情形，所以也逐个扫描 stage blob。
  for (const entry of staged) {
    if (entry.mode === "160000") continue
    let source
    try {
      source = execFileSync("git", ["cat-file", "blob", entry.objectId], {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      })
    } catch (error) {
      findings.push(`${displayPath(entry.file)} [index]: possible unreadable blob (${error?.code || "read error"})`)
      continue
    }
    if (entry.stage === "0" && worktreeSources.get(entry.file) === source) continue
    scanned++
    appendSecretFindings(findings, entry.file, source, " [index]")
  }
  return { files, scanned, findings }
}

function run() {
  const result = scanRepository(process.cwd())
  if (result.findings.length) {
    console.error(result.findings.join("\n"))
    process.exitCode = 1
  } else {
    console.log(`secret scan ok: ${result.scanned} files`)
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
const modulePath = path.resolve(fileURLToPath(import.meta.url))
let invokedAsThisModule = false
try {
  invokedAsThisModule = Boolean(invokedPath) && realpathSync(invokedPath) === realpathSync(modulePath)
} catch {
  invokedAsThisModule = invokedPath === modulePath
}
if (invokedAsThisModule) {
  run()
}
