import path from "node:path"
import { readFile } from "node:fs/promises"
import { execSync } from "node:child_process"
import { Command } from "commander"
import { buildContext, printContextWarnings } from "../context.mjs"
import { parseUnifiedDiff, previewLines } from "../review/diff-parser.mjs"
import { scoreRisk, sortReviewFiles } from "../review/risk-score.mjs"
import { defaultReviewState, readReviewState, writeReviewState } from "../review/review-store.mjs"
import { clearRejections, enqueueRejection, listRejections } from "../review/rejection-queue.mjs"
import {
  captureLocalReview,
  capturePullRequestReview,
  createBranchReviewId,
  createBranchReviewReport,
  markReportStaleness,
  renderReviewMarkdown,
  waiveFinding
} from "../review/branch-review.mjs"
import { paint } from "../theme/color.mjs"
import { applyReviewDecision, getSession, listSessions } from "../session/store.mjs"
import { getStoredToken } from "../github/auth.mjs"
import * as githubReviewApi from "../github/api.mjs"
import { PermissionEngine } from "../permission/engine.mjs"
import { appendAuditEntry } from "../storage/audit-store.mjs"
import { startAuditSpan, summarizeAuditContent } from "../audit/event.mjs"
import { escapeTerminalText } from "../provider/model-id.mjs"

function getGitDiff() {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" })
    return execSync("git diff --no-color", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return ""
  }
}

async function loadDiff(diffFile) {
  if (!diffFile) return getGitDiff()
  return readFile(path.resolve(diffFile), "utf8")
}

function renderFile(file, index, lines, theme) {
  const title = `${index + 1}. ${file.path} (+${file.added} -${file.removed}) risk=${file.riskScore}`
  console.log(paint(title, file.riskScore >= 9 ? theme.semantic.error : file.riskScore >= 6 ? theme.semantic.warn : theme.semantic.info))
  if (file.reasons.length) {
    console.log(`   reasons: ${file.reasons.join("; ")}`)
  }
  const preview = previewLines(file, lines)
  for (const line of preview) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      console.log(paint(`   ${line}`, theme.components.diff_add))
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      console.log(paint(`   ${line}`, theme.components.diff_del))
      continue
    }
    console.log(`   ${line}`)
  }
  if (file.rawLines.length > lines) {
    console.log(paint(`   ... (${file.rawLines.length - lines} more lines, use "kkcode review expand --index ${index}" )`, theme.base.muted))
  }
}

function summarize(files) {
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const risk = files.reduce((sum, file) => sum + file.riskScore, 0)
  return { fileCount: files.length, added, removed, risk }
}

async function resolveReviewSessionId(requestedSessionId, cwd) {
  if (requestedSessionId) {
    const data = await getSession(requestedSessionId)
    if (!data) return null
    return requestedSessionId
  }
  const latest = await listSessions({ cwd, limit: 1, includeChildren: true })
  if (!latest.length) return null
  return latest[0].id
}

export function validateBranchReviewOptions(options = {}) {
  if (options.pr && (options.base || options.head)) {
    throw new Error("--pr cannot be combined with --base or --head")
  }
  if (options.publish && !options.pr) {
    throw new Error("--publish requires --pr")
  }
}

export function resolveIncludeWorkingTree(options = {}) {
  return options.workingTree !== false && options.includeWorkingTree !== false
}

async function captureReviewSource({ options, cwd, token = "", github = githubReviewApi }) {
  if (options.pr) {
    return capturePullRequestReview({
      cwd,
      pullRequest: options.pr,
      token,
      github
    })
  }
  return captureLocalReview({
    cwd,
    base: options.base || null,
    head: options.head || "HEAD",
    includeWorkingTree: resolveIncludeWorkingTree(options)
  })
}

async function recaptureStoredSource(report, cwd, token = "", github = githubReviewApi) {
  if (report.source?.kind === "pull_request") {
    return capturePullRequestReview({
      cwd,
      pullRequest: `https://github.com/${report.source.owner}/${report.source.repo}/pull/${report.source.number}`,
      token,
      github
    })
  }
  return captureLocalReview({
    cwd,
    base: report.source?.baseRef || null,
    head: report.source?.headRef || "HEAD",
    includeWorkingTree: report.source?.includeWorkingTree !== false
  })
}

function printBranchReviewReport(report) {
  console.log(`review=${escapeTerminalText(report.id)}`)
  console.log(`diff=${escapeTerminalText(report.diffHash)}`)
  console.log(`gate=${escapeTerminalText(report.gate.status)} findings=${report.findings.length} coverage=${report.coverage.reviewedFiles}/${report.coverage.totalFiles}`)
  for (const finding of report.findings) {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ""}`
    console.log(`- ${escapeTerminalText(finding.severity).toUpperCase()} ${escapeTerminalText(finding.id)} ${escapeTerminalText(location)} ${escapeTerminalText(finding.title)}`)
  }
  for (const error of report.coverage.errors) console.log(`coverage: ${escapeTerminalText(error)}`)
}

export function createReviewCommand() {
  const cmd = new Command("review").description("review code changes with risk-first previews")

  cmd
    .command("open")
    .description("build review state from diff and show first previews")
    .option("--diff-file <file>", "use a diff file instead of git diff")
    .option("--session <id>", "bind review decisions to this session id")
    .option("--lines <n>", "preview lines per file")
    .action(async (options) => {
      const ctx = await buildContext()
      printContextWarnings(ctx)
      const config = ctx.configState.config
      const theme = ctx.themeState.theme
      const previewCount = Number(options.lines ?? config.review.default_lines)
      const diff = await loadDiff(options.diffFile ?? null)
      const files = parseUnifiedDiff(diff).map((file) => {
        const risk = scoreRisk(file)
        return {
          ...file,
          riskScore: risk.score,
          reasons: risk.reasons,
          status: "pending"
        }
      })
      if (files.length === 0) {
        console.log("no diff content found")
        return
      }
      const sorted = sortReviewFiles(files, config.review.sort)
      const previousState = await readReviewState()
      const state = {
        ...defaultReviewState(),
        branchReport: previousState.branchReport || null
      }
      const sessionId = await resolveReviewSessionId(options.session ?? null, process.cwd())
      if (options.session && !sessionId) {
        console.error(`session not found: ${options.session}`)
        process.exitCode = 1
        return
      }
      state.sessionId = sessionId
      state.files = sorted
      state.currentIndex = 0
      await writeReviewState(state)
      const summary = summarize(sorted)
      console.log(`summary: files=${summary.fileCount} added=${summary.added} removed=${summary.removed} totalRisk=${summary.risk}`)
      const risky = sorted.filter((file) => file.riskScore >= 6).slice(0, 5)
      if (risky.length) {
        console.log("high-risk files:")
        for (const file of risky) {
          console.log(`- ${file.path} (risk=${file.riskScore})`)
        }
      }
      if (state.sessionId) {
        console.log(`bound session: ${state.sessionId}`)
      } else {
        console.log("bound session: (none)")
      }
      for (const [index, file] of sorted.entries()) {
        renderFile(file, index, previewCount, theme)
      }
    })

  cmd
    .command("branch")
    .description("run an AI-assisted branch or pull request review")
    .option("--base <ref>", "base git ref (default: origin/HEAD)")
    .option("--head <ref>", "head git ref (default: HEAD)")
    .option("--include-working-tree", "include staged, unstaged, and untracked changes (default)", true)
    .option("--no-working-tree", "exclude staged, unstaged, and untracked changes")
    .option("--pr <number-or-url>", "review a GitHub pull request")
    .option("--provider <name>", "review provider")
    .option("--model <id>", "review model")
    .option("--publish", "create or update the KK Code PR summary comment", false)
    .option("--json", "print the versioned review report as JSON", false)
    .action(async (options) => {
      let reviewSpan = null
      let activeReviewId = ""
      let activeDiffHash = ""
      try {
        validateBranchReviewOptions(options)
        const ctx = await buildContext()
        printContextWarnings(ctx)
        const cwd = process.cwd()
        const storedAuth = options.pr ? await getStoredToken() : null
        if (options.pr && !storedAuth?.token) {
          throw new Error("GitHub authentication required; run `kkcode --github` first")
        }
        const providerType = options.provider || ctx.configState.config.provider.default
        const providerConfig = ctx.configState.config.provider[providerType] || {}
        const model = options.model || providerConfig.default_model || null
        const source = await captureReviewSource({
          options,
          cwd,
          token: storedAuth?.token || ""
        })
        const state = await readReviewState(cwd)
        activeReviewId = createBranchReviewId(source.diffHash)
        activeDiffHash = source.diffHash
        reviewSpan = await startAuditSpan({
          type: "review",
          reviewId: activeReviewId,
          provider: providerType,
          model,
          reviewSource: source.kind,
          diffHash: source.diffHash,
          baseSha: source.baseSha,
          headSha: source.headSha
        })
        const report = await createBranchReviewReport({
          source,
          configState: ctx.configState,
          providerType,
          model,
          reviewId: activeReviewId,
          traceId: reviewSpan.traceId,
          parentEventId: reviewSpan.eventId,
          previousReport: state.branchReport
        })
        state.branchReport = report
        await writeReviewState(state, cwd)

        if (options.publish) {
          PermissionEngine.setTrusted(ctx.trustState?.trusted === true)
          await appendAuditEntry({
            type: "review.publish.request",
            traceId: report.traceId,
            parentEventId: reviewSpan.eventId,
            reviewId: report.id,
            diffHash: report.diffHash,
            repository: `${source.owner}/${source.repo}`,
            pullRequest: source.number
          })
          await PermissionEngine.check({
            config: ctx.configState.config,
            sessionId: report.id,
            traceId: report.traceId,
            requestId: reviewSpan.requestId,
            reviewId: report.id,
            tool: "github_publish",
            mode: "agent",
            pattern: source.url,
            args: { repository: `${source.owner}/${source.repo}`, pullRequest: source.number },
            risk: 7,
            reason: "Create or update the KK Code pull request review comment"
          })
          try {
            const published = await githubReviewApi.upsertPullRequestReviewComment(
              storedAuth.token,
              source.owner,
              source.repo,
              source.number,
              renderReviewMarkdown(report),
              { authorLogin: storedAuth.login }
            )
            report.publish = {
              status: published.action,
              commentId: published.comment?.id || null,
              url: published.comment?.html_url || null,
              publishedAt: Date.now(),
              diffHash: report.diffHash
            }
            state.branchReport = report
            await writeReviewState(state, cwd)
            await appendAuditEntry({
              type: "review.publish.finish",
              ok: true,
              traceId: report.traceId,
              parentEventId: reviewSpan.eventId,
              reviewId: report.id,
              diffHash: report.diffHash,
              action: published.action,
              pullRequest: source.number
            })
          } catch (error) {
            await appendAuditEntry({
              type: "review.publish.error",
              ok: false,
              traceId: report.traceId,
              parentEventId: reviewSpan.eventId,
              reviewId: report.id,
              diffHash: report.diffHash,
              pullRequest: source.number,
              error: summarizeAuditContent(error?.message || "GitHub publish failed"),
              errorClass: error?.name || null
            })
            throw error
          }
        }

        await reviewSpan.finish({
          ok: !report.gate.blocked,
          status: report.gate.status,
          reviewId: report.id,
          diffHash: report.diffHash,
          findingCount: report.findings.length,
          blockingFindingIds: report.gate.blockingFindingIds
        })
        reviewSpan = null
        if (options.json) console.log(JSON.stringify(report, null, 2))
        else printBranchReviewReport(report)
        if (report.gate.blocked) process.exitCode = 2
      } catch (error) {
        await reviewSpan?.fail(new Error("branch review failed"), {
          reviewId: activeReviewId || null,
          diffHash: activeDiffHash || null,
          errorClass: error?.name || null
        })
        console.error(escapeTerminalText(error.message))
        process.exitCode = 1
      }
    })

  cmd
    .command("gate")
    .description("verify the stored branch review against the current diff")
    .option("--json", "print the versioned review report as JSON", false)
    .action(async (options) => {
      try {
        const cwd = process.cwd()
        const state = await readReviewState(cwd)
        if (!state.branchReport) throw new Error("branch review state empty. Run `kkcode review branch` first.")
        const storedAuth = state.branchReport.source?.kind === "pull_request" ? await getStoredToken() : null
        const current = await recaptureStoredSource(state.branchReport, cwd, storedAuth?.token || "")
        state.branchReport = markReportStaleness(state.branchReport, current)
        await writeReviewState(state, cwd)
        await appendAuditEntry({
          type: "review.gate",
          traceId: state.branchReport.traceId || null,
          ok: !state.branchReport.gate.blocked,
          status: state.branchReport.gate.status,
          reviewId: state.branchReport.id,
          diffHash: state.branchReport.diffHash,
          stale: state.branchReport.stale
        })
        if (options.json) console.log(JSON.stringify(state.branchReport, null, 2))
        else printBranchReviewReport(state.branchReport)
        if (state.branchReport.gate.blocked) process.exitCode = 2
      } catch (error) {
        console.error(escapeTerminalText(error.message))
        process.exitCode = 1
      }
    })

  cmd
    .command("waive")
    .description("waive one stored branch review finding")
    .argument("<finding-id>", "finding id")
    .requiredOption("--reason <text>", "waiver reason")
    .option("--json", "print the updated report as JSON", false)
    .action(async (findingId, options) => {
      try {
        const cwd = process.cwd()
        const state = await readReviewState(cwd)
        if (!state.branchReport) throw new Error("branch review state empty. Run `kkcode review branch` first.")
        const storedAuth = state.branchReport.source?.kind === "pull_request" ? await getStoredToken() : null
        const current = await recaptureStoredSource(state.branchReport, cwd, storedAuth?.token || "")
        state.branchReport = markReportStaleness(state.branchReport, current)
        state.branchReport = waiveFinding(state.branchReport, findingId, options.reason)
        await writeReviewState(state, cwd)
        await appendAuditEntry({
          type: "review.waive",
          traceId: state.branchReport.traceId || null,
          reviewId: state.branchReport.id,
          diffHash: state.branchReport.diffHash,
          findingId,
          reason: summarizeAuditContent(options.reason)
        })
        if (options.json) console.log(JSON.stringify(state.branchReport, null, 2))
        else console.log(`waived: ${findingId} gate=${state.branchReport.gate.status}`)
      } catch (error) {
        console.error(escapeTerminalText(error.message))
        process.exitCode = 1
      }
    })

  cmd
    .command("next")
    .description("move to next file preview")
    .action(async () => {
      const ctx = await buildContext()
      const config = ctx.configState.config
      const theme = ctx.themeState.theme
      const state = await readReviewState()
      if (!state.files.length) {
        console.error("review state empty. Run `kkcode review open` first.")
        process.exitCode = 1
        return
      }
      state.currentIndex = Math.min(state.currentIndex + 1, state.files.length - 1)
      await writeReviewState(state)
      renderFile(state.files[state.currentIndex], state.currentIndex, config.review.default_lines, theme)
    })

  cmd
    .command("expand")
    .description("expand current or selected file preview")
    .option("--index <n>", "file index, zero-based")
    .action(async (options) => {
      const ctx = await buildContext()
      const theme = ctx.themeState.theme
      const config = ctx.configState.config
      const state = await readReviewState()
      if (!state.files.length) {
        console.error("review state empty. Run `kkcode review open` first.")
        process.exitCode = 1
        return
      }
      const index = options.index !== undefined ? Math.max(0, Number(options.index)) : state.currentIndex
      const file = state.files[index]
      if (!file) {
        console.error(`invalid index: ${index}`)
        process.exitCode = 1
        return
      }
      const max = config.review.max_expand_lines
      renderFile(file, index, max, theme)
    })

  cmd
    .command("approve")
    .description("approve current or selected review file")
    .option("--index <n>", "file index, zero-based")
    .action(async (options) => {
      const state = await readReviewState()
      if (!state.files.length) {
        console.error("review state empty. Run `kkcode review open` first.")
        process.exitCode = 1
        return
      }
      const index = options.index !== undefined ? Math.max(0, Number(options.index)) : state.currentIndex
      const file = state.files[index]
      if (!file) {
        console.error(`invalid index: ${index}`)
        process.exitCode = 1
        return
      }
      file.status = "approved"
      await writeReviewState(state)
      if (state.sessionId) {
        await applyReviewDecision(state.sessionId, {
          file: file.path,
          status: "approved",
          riskScore: file.riskScore
        }).catch(() => {})
      } else {
        console.log("warning: no bound session id; decision not persisted to session history")
      }
      console.log(`approved: ${file.path}`)
    })

  cmd
    .command("reject")
    .description("reject current or selected review file")
    .requiredOption("--reason <reason>", "reject reason")
    .option("--index <n>", "file index, zero-based")
    .action(async (options) => {
      const state = await readReviewState()
      if (!state.files.length) {
        console.error("review state empty. Run `kkcode review open` first.")
        process.exitCode = 1
        return
      }
      const index = options.index !== undefined ? Math.max(0, Number(options.index)) : state.currentIndex
      const file = state.files[index]
      if (!file) {
        console.error(`invalid index: ${index}`)
        process.exitCode = 1
        return
      }
      file.status = "rejected"
      file.rejectReason = options.reason
      await writeReviewState(state)
      await enqueueRejection(
        {
          file: file.path,
          reason: options.reason,
          riskScore: file.riskScore
        },
        process.cwd()
      )
      if (state.sessionId) {
        await applyReviewDecision(state.sessionId, {
          file: file.path,
          status: "rejected",
          reason: options.reason,
          riskScore: file.riskScore
        }).catch(() => {})
      } else {
        console.log("warning: no bound session id; decision not persisted to session history")
      }
      console.log(`rejected: ${file.path}`)
      console.log(`reason: ${options.reason}`)
    })

  cmd
    .command("feedback")
    .description("show or clear queued rejection feedback")
    .option("--clear", "clear all queued feedback", false)
    .action(async (options) => {
      if (options.clear) {
        await clearRejections(process.cwd())
        console.log("rejection feedback queue cleared")
        return
      }
      const list = await listRejections(process.cwd())
      if (!list.length) {
        console.log("no rejection feedback found")
        return
      }
      console.log(JSON.stringify(list, null, 2))
    })

  return cmd
}
