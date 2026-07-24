import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  captureLocalReview,
  capturePullRequestReview,
  createBranchReviewReport,
  deterministicFindings,
  evaluateReviewGate,
  markReportStaleness,
  normalizeModelFindings,
  parseGitHubRemote,
  redactReviewDiff,
  renderReviewMarkdown,
  resolvePullRequestReference,
  sha256,
  waiveFinding
} from "../src/review/branch-review.mjs"
import { resolveIncludeWorkingTree, validateBranchReviewOptions } from "../src/commands/review.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import {
  listCommitCheckRuns,
  listCommitStatuses,
  upsertPullRequestReviewComment,
  validateGitHubRepository
} from "../src/github/api.mjs"

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "kkcode-branch-review-"))
  git(cwd, "init", "-b", "main")
  git(cwd, "config", "user.email", "review@example.com")
  git(cwd, "config", "user.name", "Review Test")
  await writeFile(join(cwd, "app.mjs"), "export const value = 1\n", "utf8")
  git(cwd, "add", "app.mjs")
  git(cwd, "commit", "-m", "initial")
  git(cwd, "switch", "-c", "feature")
  return cwd
}

const SAFE_DIFF = [
  "diff --git a/app.mjs b/app.mjs",
  "index 77aabb1..88ccdd2 100644",
  "--- a/app.mjs",
  "+++ b/app.mjs",
  "@@ -1 +1,2 @@",
  " export const value = 1",
  "+export const next = value + 1"
].join("\n")

test("local review snapshot freezes commits and includes untracked worktree files", async () => {
  const cwd = await createRepository()
  try {
    await writeFile(join(cwd, "app.mjs"), "export const value = 2\n", "utf8")
    git(cwd, "add", "app.mjs")
    git(cwd, "commit", "-m", "feature")
    await writeFile(join(cwd, "notes.txt"), "untracked\n", "utf8")

    const source = await captureLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      includeWorkingTree: true
    })

    assert.equal(source.kind, "local")
    assert.match(source.baseSha, /^[a-f0-9]{40}$/)
    assert.match(source.headSha, /^[a-f0-9]{40}$/)
    assert.match(source.mergeBase, /^[a-f0-9]{40}$/)
    assert.match(source.diff, /app\.mjs/)
    assert.match(source.diff, /notes\.txt/)
    assert.doesNotMatch(source.diff, /\/dev\/null/)
    assert.equal(source.diffHash, sha256(source.diff))
    const repeated = await captureLocalReview({
      cwd,
      base: "main",
      head: "HEAD",
      includeWorkingTree: true
    })
    assert.equal(repeated.diffHash, source.diffHash)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("local review includes the working tree by default and supports explicit exclusion", async () => {
  const cwd = await createRepository()
  try {
    await writeFile(join(cwd, "app.mjs"), "eval(userInput)\n", "utf8")
    await writeFile(join(cwd, "untracked.mjs"), "export const added = true\n", "utf8")

    const included = await captureLocalReview({ cwd, base: "main" })
    assert.equal(included.includeWorkingTree, true)
    assert.match(included.diff, /eval\(userInput\)/)
    assert.match(included.diff, /untracked\.mjs/)

    const excluded = await captureLocalReview({ cwd, base: "main", includeWorkingTree: false })
    assert.equal(excluded.includeWorkingTree, false)
    assert.equal(excluded.diff, "")
    assert.equal(resolveIncludeWorkingTree({}), true)
    assert.equal(resolveIncludeWorkingTree({ workingTree: false }), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("local review gives an actionable error when origin/HEAD is unavailable", async () => {
  const cwd = await createRepository()
  try {
    await assert.rejects(
      captureLocalReview({ cwd }),
      /pass --base <ref>/
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("local review uses merge-base rather than the named base tip", async () => {
  const cwd = await createRepository()
  try {
    git(cwd, "update-ref", "refs/remotes/origin/main", "main")
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    await writeFile(join(cwd, "app.mjs"), "export const value = 2\n", "utf8")
    git(cwd, "add", "app.mjs")
    git(cwd, "commit", "-m", "feature")
    const source = await captureLocalReview({ cwd, head: "feature" })
    assert.equal(source.baseRef, "origin/HEAD")
    assert.equal(source.mergeBase, source.baseSha)
    assert.notEqual(source.headSha, source.baseSha)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("deterministic scanner reports secrets and dynamic execution as blockers", () => {
  const diff = SAFE_DIFF.replace(
    "+export const next = value + 1",
    "+const api_key = 'abcdefghijklmnopqrstuvwx'\n+eval(userInput)"
  ).replace("@@ -1 +1,2 @@", "@@ -1 +1,3 @@")
  const findings = deterministicFindings(diff)
  const secretFinding = findings.find((finding) => finding.severity === "critical" && finding.category === "secret")
  assert.ok(secretFinding)
  assert.equal(secretFinding.evidence.redacted, true)
  assert.doesNotMatch(JSON.stringify(secretFinding), /abcdefghijklmnopqrstuvwx/)
  assert.ok(findings.some((finding) => finding.severity === "high" && finding.category === "code_execution"))
  const report = {
    stale: false,
    findings,
    waivers: [],
    coverage: { complete: true }
  }
  assert.equal(evaluateReviewGate(report).status, "blocked")
})

test("model findings validate paths and new-file line ranges", () => {
  const raw = [
    {
      severity: "high",
      confidence: "high",
      category: "correctness",
      file: "app.mjs",
      line: 2,
      title: "Valid issue",
      evidence: "next",
      recommendation: "Fix it"
    },
    {
      severity: "critical",
      confidence: 1,
      category: "correctness",
      file: "../outside.mjs",
      line: 2,
      title: "Unknown file"
    },
    {
      severity: "high",
      confidence: 1,
      category: "correctness",
      file: "app.mjs",
      line: 9000,
      title: "Invalid line"
    }
  ]
  const findings = normalizeModelFindings(raw, SAFE_DIFF)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 2)
  assert.equal(findings[0].confidence, 0.9)
  assert.equal(findings[0].evidence.redacted, true)
  assert.doesNotMatch(JSON.stringify(findings[0]), /"next"/)
})

test("model finding paths preserve real a/b directories and paths containing spaces", () => {
  const diff = [
    "diff --git a/a/file name.mjs b/a/file name.mjs",
    "--- a/a/file name.mjs\t",
    "+++ b/a/file name.mjs\t",
    "@@ -0,0 +1 @@",
    "+eval(userInput)"
  ].join("\n")
  const findings = normalizeModelFindings([{
    severity: "high",
    file: "a/file name.mjs",
    line: 1,
    title: "Unsafe evaluation"
  }], diff)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].file, "a/file name.mjs")

  const deterministic = deterministicFindings(diff)
  assert.equal(deterministic[0].file, "a/file name.mjs")
})

test("review findings and GitHub markdown neutralize terminal injection, links, and mentions", () => {
  const findings = normalizeModelFindings([{
    severity: "high",
    file: "app.mjs",
    line: 2,
    title: "alert\u001b]8;;https://evil.example\u0007 @security [click](https://evil.example)",
    recommendation: "@everyone run **unsafe**"
  }], SAFE_DIFF)
  assert.equal(findings.length, 1)
  assert.doesNotMatch(findings[0].title, /[\u001b\u0007]/)
  assert.match(findings[0].title, /\\u001b/)

  const markdown = renderReviewMarkdown({
    source: { kind: "pull_request", owner: "example", repo: "repo", number: 7 },
    diffHash: "a".repeat(64),
    gate: { status: "blocked" },
    coverage: {
      reviewedFiles: 1,
      totalFiles: 1,
      errors: ["check\u001b[31m @ops [details](https://evil.example)"]
    },
    findings,
    waivers: [{ findingId: findings[0].id, reason: "@admins [approve](https://evil.example)" }]
  })
  assert.doesNotMatch(markdown, /[\u001b\u0007]/)
  assert.doesNotMatch(markdown, /@(?:security|everyone|ops|admins)/)
  assert.match(markdown, /&#64;security/)
  assert.match(markdown, /\\\[click\\\]\\\(/)
  assert.match(markdown, /\\\*\\\*unsafe\\\*\\\*/)
})

test("AI report is structured, blocks high findings, and preserves waivers for the same diff", async () => {
  const source = {
    kind: "local",
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBase: "a".repeat(40),
    includeWorkingTree: false,
    diff: SAFE_DIFF,
    diffHash: sha256(SAFE_DIFF)
  }
  const request = async () => ({
    text: JSON.stringify({
      findings: [{
        severity: "high",
        confidence: 0.91,
        category: "correctness",
        file: "app.mjs",
        line: 2,
        title: "Incorrect derived value",
        evidence: "next",
        recommendation: "Compute the expected value."
      }]
    })
  })
  const configState = { config: structuredClone(DEFAULT_CONFIG) }
  const report = await createBranchReviewReport({
    source,
    configState,
    providerType: "openai",
    model: "review-model",
    request
  })
  assert.equal(report.schema, "kk.review.v1")
  assert.equal(report.gate.status, "blocked")
  assert.equal(report.coverage.complete, true)
  assert.equal("diff" in JSON.parse(JSON.stringify(report.source)), false)

  const waived = waiveFinding(report, report.findings[0].id, "Accepted until the follow-up refactor.")
  assert.equal(waived.gate.blocked, false)
  const repeated = await createBranchReviewReport({
    source,
    configState,
    providerType: "openai",
    model: "review-model",
    request,
    previousReport: waived
  })
  assert.equal(repeated.waivers.length, 1)
})

test("review model requests inherit umbrella audit context and redact credentials", async () => {
  const credential = "abcdefghijklmnopqrstuvwx"
  const diff = SAFE_DIFF.replace(
    "+export const next = value + 1",
    `+const api_key = '${credential}'`
  )
  const calls = []
  const report = await createBranchReviewReport({
    source: {
      kind: "local",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      diff,
      diffHash: sha256(diff)
    },
    configState: { config: structuredClone(DEFAULT_CONFIG) },
    providerType: "openai",
    model: "review-model",
    reviewId: "review-correlated",
    traceId: "trace-review-correlated",
    parentEventId: "event-review-start",
    request: async (input) => {
      calls.push(input)
      return { text: "{\"findings\":[]}" }
    }
  })
  assert.equal(report.id, "review-correlated")
  assert.equal(report.traceId, "trace-review-correlated")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reviewId, report.id)
  assert.equal(calls[0].traceId, report.traceId)
  assert.equal(calls[0].parentEventId, "event-review-start")
  assert.doesNotMatch(calls[0].messages[0].content, new RegExp(credential))
  assert.match(calls[0].messages[0].content, /REDACTED/)
  assert.doesNotMatch(redactReviewDiff(diff), new RegExp(credential))
})

test("invalid model output makes review incomplete and fail-closed", async () => {
  const source = {
    kind: "local",
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBase: "a".repeat(40),
    includeWorkingTree: false,
    diff: SAFE_DIFF,
    diffHash: sha256(SAFE_DIFF)
  }
  const report = await createBranchReviewReport({
    source,
    configState: { config: structuredClone(DEFAULT_CONFIG) },
    providerType: "openai",
    model: "review-model",
    request: async () => ({ text: "not-json" })
  })
  assert.equal(report.coverage.complete, false)
  assert.equal(report.gate.status, "blocked")
  assert.match(report.coverage.errors[0], /JSON findings array/)
})

test("skipped binary and generated files make review coverage incomplete", async () => {
  const diff = [
    "diff --git a/image.bin b/image.bin",
    "new file mode 100644",
    "index 0000000..1234567",
    "Binary files /dev/null and b/image.bin differ",
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "-{}",
    "+{\"lockfileVersion\":3}"
  ].join("\n")
  const report = await createBranchReviewReport({
    source: {
      kind: "local",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      diff,
      diffHash: sha256(diff)
    },
    configState: { config: structuredClone(DEFAULT_CONFIG) },
    providerType: "openai",
    model: "review-model",
    request: async () => {
      throw new Error("skipped files must not be sent to the model")
    }
  })
  assert.equal(report.coverage.reviewedFiles, 0)
  assert.equal(report.coverage.totalFiles, 2)
  assert.equal(report.coverage.complete, false)
  assert.equal(report.gate.status, "blocked")
  assert.ok(report.coverage.errors.some((error) => error.includes("binary files")))
  assert.ok(report.coverage.errors.some((error) => error.includes("generated or lock files")))
})

test("gate only accepts reasoned waivers and requires explicit complete coverage", () => {
  const finding = { id: "finding-high", severity: "high", title: "Unsafe" }
  const validReport = {
    schema: "kk.review.v1",
    id: "review-valid",
    diffHash: "a".repeat(64),
    source: { kind: "local" },
    stale: false
  }
  assert.equal(evaluateReviewGate({
    ...validReport,
    findings: [finding],
    waivers: [{ findingId: finding.id, reason: " " }],
    coverage: { complete: true }
  }).blocked, true)
  assert.equal(evaluateReviewGate({
    ...validReport,
    findings: [finding],
    waivers: [{ findingId: finding.id, reason: "Approved by owner" }],
    coverage: { complete: true }
  }).blocked, false)
  assert.equal(evaluateReviewGate({
    ...validReport,
    findings: [],
    waivers: []
  }).blocked, true)
})

test("stale diff invalidates a prior gate and cannot be waived", () => {
  const report = {
    id: "review-1",
    diffHash: "old",
    source: { baseSha: "a", headSha: "b" },
    stale: false,
    findings: [{
      id: "finding-1",
      severity: "high",
      file: "app.mjs",
      title: "Issue"
    }],
    waivers: [],
    coverage: { complete: true }
  }
  const stale = markReportStaleness(report, { diffHash: "new", baseSha: "a", headSha: "c" })
  assert.equal(stale.stale, true)
  assert.equal(stale.gate.status, "blocked")
  assert.throws(() => waiveFinding(stale, "finding-1", "reason"), /stale review/)
})

test("PR references, option conflicts, and injected GitHub capture are deterministic", async () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:kkelly-offical/kkcode.git"), {
    owner: "kkelly-offical",
    repo: "kkcode"
  })
  assert.deepEqual(
    await resolvePullRequestReference("https://github.com/kkelly-offical/kkcode/pull/32"),
    { owner: "kkelly-offical", repo: "kkcode", number: 32 }
  )
  assert.equal(parseGitHubRemote("git@github.com:../repos.git"), null)
  assert.throws(
    () => validateGitHubRepository("example", ".."),
    /invalid GitHub repository name/
  )
  await assert.rejects(
    resolvePullRequestReference("https://github.com/example/../pull/32"),
    /invalid GitHub repository name/
  )
  assert.throws(
    () => validateBranchReviewOptions({ pr: "32", base: "main" }),
    /cannot be combined/
  )
  assert.throws(
    () => validateBranchReviewOptions({ publish: true }),
    /requires --pr/
  )

  const github = {
    getPullRequest: async () => ({
      html_url: "https://github.com/kkelly-offical/kkcode/pull/32",
      title: "Review",
      state: "open",
      draft: false,
      changed_files: 1,
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "feature", sha: "b".repeat(40) }
    }),
    getPullRequestDiff: async () => SAFE_DIFF,
    compareCommits: async () => ({ merge_base_commit: { sha: "c".repeat(40) } }),
    listCommitCheckRuns: async () => [{ name: "test", status: "completed", conclusion: "success" }],
    listCommitStatuses: async () => [{ name: "deploy", status: "completed", conclusion: "success" }]
  }
  const source = await capturePullRequestReview({
    pullRequest: "https://github.com/kkelly-offical/kkcode/pull/32",
    token: "not-a-real-token",
    github
  })
  assert.equal(source.kind, "pull_request")
  assert.equal(source.mergeBase, "c".repeat(40))
  assert.equal(source.checks[0].conclusion, "success")
  assert.equal(source.checks[1].name, "deploy")
  assert.equal(source.diffHash, sha256(SAFE_DIFF))
  assert.match(renderReviewMarkdown({
    source,
    diffHash: source.diffHash,
    gate: { status: "passed" },
    coverage: { reviewedFiles: 1, totalFiles: 1, errors: [] },
    findings: [],
    waivers: []
  }), /<!-- kkcode-review:kkelly-offical\/kkcode#32 -->/)
})

test("PR publishing updates only the author's exact scoped marker", async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const marker = "<!-- kkcode-review:example/repo#32 -->"
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith("/issues/32/comments?per_page=100&page=1")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 121, user: { login: "other" }, body: `old\n${marker}` },
          { id: 122, user: { login: "kkcode-user" }, body: `quoted ${marker}` },
          { id: 123, user: { login: "kkcode-user" }, body: `old\n${marker}` }
        ]
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 123, html_url: "https://github.com/example/repo/pull/32#issuecomment-123" })
    }
  }
  try {
    const result = await upsertPullRequestReviewComment(
      "not-a-real-token",
      "example",
      "repo",
      32,
      `new\n${marker}\n<!-- kkcode-diff-hash:abc -->`,
      { authorLogin: "kkcode-user" }
    )
    assert.equal(result.action, "updated")
    assert.equal(requests.length, 2)
    assert.equal(requests[1].init.method, "PATCH")
    assert.match(requests[1].url, /issues\/comments\/123$/)
    assert.match(requests[1].init.body, /kkcode-diff-hash:abc/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("PR publishing performs no mutation when its existing body is unchanged", async () => {
  const originalFetch = globalThis.fetch
  const marker = "<!-- kkcode-review:example/repo#32 -->"
  const body = `unchanged\n${marker}\n<!-- kkcode-diff-hash:abc -->`
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 123, user: { login: "kkcode-user" }, body }]
    }
  }
  try {
    const result = await upsertPullRequestReviewComment(
      "not-a-real-token",
      "example",
      "repo",
      32,
      body,
      { authorLogin: "kkcode-user" }
    )
    assert.equal(result.action, "unchanged")
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("PR check runs and combined commit statuses are fully paginated", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    const page = Number(parsed.searchParams.get("page"))
    if (parsed.pathname.endsWith("/check-runs")) {
      const batch = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: `check-${index + 1}`,
            status: "completed",
            conclusion: "success"
          }))
        : [{ id: 101, name: "late-failure", status: "completed", conclusion: "failure" }]
      return { ok: true, status: 200, json: async () => ({ total_count: 101, check_runs: batch }) }
    }
    const statuses = page === 1
      ? [{ id: 1, context: "legacy-ci", state: "failure", target_url: "https://ci.example.test/1" }]
      : []
    return { ok: true, status: 200, json: async () => ({ total_count: 1, statuses }) }
  }
  try {
    const runs = await listCommitCheckRuns("token", "example", "repo", "head")
    const statuses = await listCommitStatuses("token", "example", "repo", "head")
    assert.equal(runs.length, 101)
    assert.equal(runs.at(-1).conclusion, "failure")
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].source, "commit_status")
    assert.equal(statuses[0].conclusion, "failure")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("incomplete or failed pull-request checks fail the review closed", async () => {
  const source = {
    kind: "pull_request",
    owner: "example",
    repo: "repo",
    number: 32,
    changedFiles: 1,
    baseRef: "main",
    headRef: "feature",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBase: "a".repeat(40),
    checks: [
      { name: "build", status: "completed", conclusion: "failure" },
      { name: "test", status: "in_progress", conclusion: null }
    ],
    diff: SAFE_DIFF,
    diffHash: sha256(SAFE_DIFF)
  }
  const report = await createBranchReviewReport({
    source,
    configState: { config: structuredClone(DEFAULT_CONFIG) },
    providerType: "openai",
    model: "review-model",
    request: async () => ({ text: "{\"findings\":[]}" })
  })
  assert.equal(report.coverage.complete, false)
  assert.equal(report.gate.status, "blocked")
  assert.ok(report.coverage.errors.some((error) => error.includes("checks failed")))
  assert.ok(report.coverage.errors.some((error) => error.includes("checks are incomplete")))

  const checksRecovered = markReportStaleness(report, {
    ...source,
    checks: [{ name: "build", status: "completed", conclusion: "success" }]
  })
  assert.equal(checksRecovered.stale, false)
  assert.equal(checksRecovered.coverage.complete, true)
  assert.equal(checksRecovered.gate.status, "passed")
})
