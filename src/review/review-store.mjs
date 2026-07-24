import { ensureProjectRoot, reviewStorePath } from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"

export function defaultReviewState() {
  return {
    createdAt: Date.now(),
    sessionId: null,
    currentIndex: 0,
    files: [],
    branchReport: null
  }
}

export async function readReviewState(cwd = process.cwd()) {
  await ensureProjectRoot(cwd)
  const fallback = defaultReviewState()
  const stored = await readJson(reviewStorePath(cwd), fallback)
  if (!stored || typeof stored !== "object") return fallback
  return {
    ...fallback,
    ...stored,
    files: Array.isArray(stored.files) ? stored.files : [],
    branchReport: stored.branchReport && typeof stored.branchReport === "object"
      ? stored.branchReport
      : null
  }
}

export async function writeReviewState(state, cwd = process.cwd()) {
  await ensureProjectRoot(cwd)
  await writeJson(reviewStorePath(cwd), state)
}
