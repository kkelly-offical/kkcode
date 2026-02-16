import path from "node:path"
import { readFile } from "node:fs/promises"
import { execSync } from "node:child_process"
import { Command } from "commander"
import { buildContext, printContextWarnings } from "../context.mjs"
import { parseUnifiedDiff, previewLines } from "../review/diff-parser.mjs"
import { scoreRisk, sortReviewFiles } from "../review/risk-score.mjs"
import { defaultReviewState, readReviewState, writeReviewState } from "../review/review-store.mjs"
import { clearRejections, enqueueRejection, listRejections } from "../review/rejection-queue.mjs"
import { paint } from "../theme/color.mjs"
import { applyReviewDecision, getSession, listSessions } from "../session/store.mjs"

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
      const state = defaultReviewState()
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
