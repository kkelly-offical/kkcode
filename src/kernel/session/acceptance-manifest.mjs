import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readlink, realpath } from "node:fs/promises"
import path from "node:path"
import { normalizeGoal, freezeGoal } from "./goal-model.mjs"
import { runControlledGit } from "../../util/controlled-git.mjs"

const SCHEMA = "kk.acceptance-manifest.v1"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function acceptanceDefinition(goal) {
  if (!goal || typeof goal !== "object") throw new TypeError("acceptance goal is required")
  const definition = {
    goalId: goal.goalId, objective: goal.objective, nonGoals: goal.nonGoals || [],
    criteria: goal.criteria || [],
    subGoals: (goal.subGoals || []).map((sub) => ({
      goalId: sub.goalId, title: sub.title, optional: sub.optional === true,
      stageIds: sub.stageIds || [], criteria: sub.criteria || []
    }))
  }
  const criteria = [...definition.criteria, ...definition.subGoals.flatMap((sub) => sub.criteria)]
  const ids = new Set()
  for (const criterion of criteria) {
    if (!criterion.id || ids.has(criterion.id)) throw new TypeError("acceptance criterion IDs must be unique and nonempty")
    ids.add(criterion.id)
  }
  if (!criteria.length) throw new TypeError("acceptance manifest requires criteria")
  return definition
}

function goalCommands(definition) {
  return [...definition.criteria, ...definition.subGoals.flatMap((sub) => sub.criteria)]
    .filter((criterion) => ["command_exit", "test_pass"].includes(criterion.kind))
    .map((criterion) => ({ criterionId: criterion.id, ...criterion.spec }))
}

function verificationPolicy(config) {
  return {
    gates: config?.agent?.longagent?.usability_gates || {},
    criteria: config?.agent?.longagent?.ultra?.criteria || {}
  }
}

/** Prepare once, before model work; persist this in host-private run state. */
export async function prepareHostAcceptance({ cwd, acceptance, signal = null }) {
  signal?.throwIfAborted()
  if (acceptance?.required !== true || !acceptance.goal || !Array.isArray(acceptance.testSources) || !acceptance.testSources.length) {
    throw new Error("strict acceptance requires a host-approved goal and nonempty test source list")
  }
  const root = await realpath(cwd)
  const normalized = normalizeGoal(structuredClone(acceptance.goal), { objective: acceptance.goal.objective })
  if (!normalized.goal || normalized.errors.length) throw new Error(`invalid host acceptance goal: ${normalized.errors.join("; ")}`)
  const goal = freezeGoal(normalized.goal)
  acceptanceDefinition(goal)
  for (const criterion of [...goal.criteria, ...goal.subGoals.flatMap(sub => sub.criteria)]) {
    if (["file_exists", "content_match"].includes(criterion.kind)) sourcePath(root, criterion.spec.path)
  }
  const testSources = [...acceptance.testSources]
  // Package scripts choose what build/test means. They are governing test
  // sources even when a caller only names the assertion files.
  try {
    if (!(await lstat(path.join(root, "package.json"))).isFile()) throw new Error("strict package.json acceptance source must be a regular file")
    testSources.push("package.json")
  }
  catch (error) { if (error.code !== "ENOENT") throw error }
  const sourceBaseline = await captureAcceptanceSources({ cwd: root, paths: testSources })
  if (acceptance.sourceBaseline && (acceptance.sourceBaseline.schema !== sourceBaseline.schema
    || acceptance.sourceBaseline.fingerprint !== digest(acceptance.sourceBaseline.files)
    || acceptance.sourceBaseline.fingerprint !== sourceBaseline.fingerprint)) {
    throw new Error("original acceptance source baseline changed; refusing to approve a replacement")
  }
  const baseRevision = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${acceptance.baseRevision || "HEAD"}^{commit}`])).trim()
  const body = {
    schema: "kk.host-acceptance.v1", cwd: root, goal, baseRevision,
    testSources: sourceBaseline.files.map(file => file.path), sourceBaseline,
    contractFingerprint: digest(acceptanceDefinition(goal))
  }
  signal?.throwIfAborted()
  return deepFreeze({ ...body, id: digest(body) })
}

/** Restore only host-held metadata; never take this boundary from tool arguments. */
export async function restoreHostAcceptance(boundary, { cwd, onReceipt, runCommand, signal = null }) {
  signal?.throwIfAborted()
  const { id, ...body } = boundary || {}
  if (body.schema !== "kk.host-acceptance.v1" || id !== digest(body)
    || body.cwd !== await realpath(cwd) || !body.sourceBaseline?.files?.length
    || body.contractFingerprint !== digest(acceptanceDefinition(body.goal))) {
    throw new Error("host acceptance boundary is missing, corrupt or belongs to another workspace")
  }
  const sources = await captureAcceptanceSources({ cwd, paths: body.testSources })
  if (sources.fingerprint !== body.sourceBaseline.fingerprint) throw new Error("original acceptance sources changed; resume requires inspection")
  const base = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${body.baseRevision}^{commit}`])).trim()
  if (base !== body.baseRevision) throw new Error("original acceptance base revision is unavailable")
  if (typeof runCommand !== "function" || typeof onReceipt !== "function") {
    throw new Error("strict acceptance requires host-owned command execution and durable receipt callbacks")
  }
  return Object.freeze({ required: true, boundary: deepFreeze(structuredClone(boundary)), runCommand, onReceipt })
}

export function createVerificationReceipt({ boundary, manifest, verification, gates, commands = [] }) {
  const body = {
    schema: "kk.verification-receipt.v1", boundaryId: boundary.id, manifestId: manifest.id,
    candidateHash: manifest.candidate.treeFingerprint, candidate: manifest.candidate,
    criteriaFingerprint: manifest.criteriaFingerprint, commandFingerprint: manifest.commandFingerprint,
    policyFingerprint: manifest.policyFingerprint, baseRevision: manifest.baseRevision,
    sourcesFingerprint: manifest.sources.fingerprint, status: verification.status,
    allPass: verification.status === "met" && gates?.allPass === true,
    criteria: [...verification.results, ...verification.subGoals.flatMap(sub => sub.results)].map(result => ({
      ...result, verificationStatus: result.status,
      status: result.status === "pass" ? "passed" : result.status === "fail" ? "failed" : "unknown"
    })),
    gates: gates?.gates || {}, commands, evidenceRefs: [], evaluatedAt: verification.evaluatedAt
  }
  return deepFreeze({ ...body, id: digest(body) })
}

async function git(cwd, args) {
  const result = await runControlledGit(args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  if (!result.ok) throw new Error(result.stderr || "controlled Git inspection failed")
  return result.stdout
}

function sourcePath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\0")) {
    throw new TypeError("acceptance source must be a workspace-relative file")
  }
  const target = path.resolve(root, relative)
  const within = path.relative(root, target)
  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new TypeError("acceptance source is outside the workspace")
  }
  return target
}

async function fingerprintFile(root, relative) {
  const target = sourcePath(root, relative)
  let before
  try { before = await lstat(target) } catch (error) {
    if (error.code === "ENOENT") return { path: relative, kind: "missing" }
    throw error
  }
  if (before.isSymbolicLink()) {
    return { path: relative, kind: "symlink", hash: digest(await readlink(target)) }
  }
  if (!before.isFile()) throw new Error(`acceptance source is not a regular file: ${relative}`)
  const resolved = await realpath(target)
  const within = path.relative(root, resolved)
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error(`acceptance source resolves outside the workspace: ${relative}`)
  }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await file.stat()
    if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new Error(`acceptance source changed while opening: ${relative}`)
    }
    const hash = createHash("sha256")
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`acceptance source changed while hashing: ${relative}`)
    }
    return { path: relative, kind: "file", executable: Boolean(before.mode & 0o111), size: before.size, hash: hash.digest("hex") }
  } finally { await file.close() }
}

/**
 * Capture this before implementation to prevent rewriting the acceptance source.
 * @param {{cwd?: string, paths?: string[]}} [options]
 */
export async function captureAcceptanceSources({ cwd, paths = [] } = {}) {
  if (!cwd) throw new TypeError("acceptance workspace is required")
  const root = await realpath(cwd)
  const files = []
  for (const name of [...new Set(paths)].sort()) {
    const entry = await fingerprintFile(root, name)
    // A symlink does not attest its target's content; never accept it as a test source.
    if (entry.kind !== "file") throw new Error(`acceptance test source must exist as a regular file: ${name}`)
    files.push(entry)
  }
  return deepFreeze({ schema: "kk.acceptance-sources.v1", files, fingerprint: digest(files) })
}

async function captureCandidate(cwd, { includeFiles = false } = {}) {
  const root = await realpath(cwd)
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  const paths = [...new Set((await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean))].sort()
  if (paths.length > 100_000) throw new Error("acceptance candidate exceeds file capture limit")
  const files = []
  for (const name of paths) files.push(await fingerprintFile(root, name))
  const endHead = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  const endPaths = [...new Set((await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean))].sort()
  if (endHead !== head || JSON.stringify(endPaths) !== JSON.stringify(paths)) throw new Error("acceptance candidate changed during capture")
  return { head, treeFingerprint: digest(files), fileCount: files.length, ...(includeFiles ? { files } : {}) }
}

export { captureCandidate as captureAcceptanceCandidate }
export { fingerprintFile as fingerprintAcceptanceFile }

/**
 * Host-owned evidence, not an authorization signature. Never accept a manifest
 * supplied by model/tool arguments as a replacement for the host's saved copy.
 * Full worktree content is bound, including untracked files (not ignored outputs).
 * Submodules/non-regular tracked objects fail closed until separately supported.
 * @param {{goal?: Record<string, any>, cwd?: string, baseRevision?: string,
 * testSources?: string[], sourceBaseline?: Record<string, any>|null, config?: Record<string, any>|null,
 * hostBoundaryId?: string|null, approvedCommands?: Record<string, any>[]}} [options]
 */
export async function captureAcceptanceManifest({
  goal, cwd, baseRevision = "HEAD", testSources = [], sourceBaseline = null, config = null, hostBoundaryId = null, approvedCommands = []
} = {}) {
  if (!cwd) throw new TypeError("acceptance workspace is required")
  const definition = acceptanceDefinition(goal)
  const sources = await captureAcceptanceSources({ cwd, paths: sourceBaseline?.files?.map((file) => file.path) || testSources })
  if (sourceBaseline && (sourceBaseline.schema !== "kk.acceptance-sources.v1" ||
      sourceBaseline.fingerprint !== digest(sourceBaseline.files) || sourceBaseline.fingerprint !== sources.fingerprint)) {
    throw new Error("acceptance test sources changed since the host-approved baseline")
  }
  const base = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${baseRevision}^{commit}`])).trim()
  const manifest = {
    schema: SCHEMA, createdAt: new Date().toISOString(), baseRevision: base,
    ...(config ? { policyFingerprint: digest(verificationPolicy(config)) } : {}),
    ...(hostBoundaryId ? { hostBoundaryId } : {}),
    criteriaFingerprint: digest(definition), approvedCommands,
    commandFingerprint: digest([...goalCommands(definition), ...approvedCommands]),
    candidate: await captureCandidate(cwd), sources,
    independentSourceBaseline: Boolean(sourceBaseline?.files?.length)
  }
  return deepFreeze({ ...manifest, id: digest(manifest) })
}

/**
 * Return unknown rather than a successful receipt when evidence is stale/missing.
 * @param {Record<string, any>|null} manifest
 * @param {{goal?: Record<string, any>, cwd?: string, config?: Record<string, any>}} [options]
 */
export async function validateAcceptanceManifest(manifest, { goal, cwd, config } = {}) {
  const errors = []
  try {
    if (!cwd) throw new TypeError("acceptance workspace is required")
    if (!manifest || manifest.schema !== SCHEMA) throw new Error("acceptance manifest is missing or unsupported")
    const { id, ...body } = manifest
    if (id !== digest(body)) throw new Error("acceptance manifest integrity check failed")
    const definition = acceptanceDefinition(goal)
    if (manifest.criteriaFingerprint !== digest(definition)) errors.push("acceptance criteria changed")
    if (manifest.commandFingerprint !== digest([...goalCommands(definition), ...(manifest.approvedCommands || [])])) errors.push("acceptance commands changed")
    if (manifest.policyFingerprint && manifest.policyFingerprint !== digest(verificationPolicy(config))) errors.push("acceptance execution policy changed")
    const base = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${manifest.baseRevision}^{commit}`])).trim()
    if (base !== manifest.baseRevision) errors.push("acceptance base revision is unavailable")
    const candidate = await captureCandidate(cwd)
    if (candidate.head !== manifest.candidate.head || candidate.treeFingerprint !== manifest.candidate.treeFingerprint) {
      errors.push("acceptance candidate changed")
    }
    const sources = await captureAcceptanceSources({ cwd, paths: manifest.sources.files.map((file) => file.path) })
    if (sources.fingerprint !== manifest.sources.fingerprint) errors.push("acceptance test sources changed")
  } catch (error) { errors.push(String(error?.message || error).slice(0, 500)) }
  return { ok: errors.length === 0, status: errors.length ? "unknown" : "valid", manifestId: manifest?.id || null, errors }
}
