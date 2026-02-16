import { ensureProjectRoot, reviewStorePath } from "../storage/paths.mjs"
import { readJson, writeJson } from "../storage/json-store.mjs"

export function defaultReviewState() {
  return {
    createdAt: Date.now(),
    sessionId: null,
    currentIndex: 0,
    files: []
  }
}

export async function readReviewState(cwd = process.cwd()) {
  await ensureProjectRoot(cwd)
  return readJson(reviewStorePath(cwd), defaultReviewState())
}

export async function writeReviewState(state, cwd = process.cwd()) {
  await ensureProjectRoot(cwd)
  await writeJson(reviewStorePath(cwd), state)
}
