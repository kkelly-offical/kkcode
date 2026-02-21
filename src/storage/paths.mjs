import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"

export function userRootDir() {
  return process.env.KKCODE_HOME || path.join(os.homedir(), ".kkcode")
}

export function projectRootDir(cwd = process.cwd()) {
  return path.join(cwd, ".kkcode")
}

export function userConfigCandidates() {
  const root = userRootDir()
  return [
    path.join(root, "config.yaml"),
    path.join(root, "config.yml"),
    path.join(root, "config.json"),
    path.join(root, "kkcode.config.yaml"),
    path.join(root, "kkcode.config.yml"),
    path.join(root, "kkcode.config.json")
  ]
}

export function projectConfigCandidates(cwd = process.cwd()) {
  return [
    path.join(cwd, "kkcode.config.yaml"),
    path.join(cwd, "kkcode.config.yml"),
    path.join(cwd, "kkcode.config.json"),
    path.join(projectRootDir(cwd), "config.yaml"),
    path.join(projectRootDir(cwd), "config.yml"),
    path.join(projectRootDir(cwd), "config.json")
  ]
}

export function usageStorePath() {
  return path.join(userRootDir(), "usage.json")
}

export function trustFilePath(cwd = process.cwd()) {
  return path.join(projectRootDir(cwd), "trust.json")
}

export function reviewStorePath(cwd = process.cwd()) {
  return path.join(projectRootDir(cwd), "review-state.json")
}

export function sessionStorePath() {
  // Legacy monolithic store path kept for migration.
  return path.join(userRootDir(), "session-store.json")
}

export function sessionShardRootPath() {
  return path.join(userRootDir(), "sessions")
}

export function sessionIndexPath() {
  return path.join(sessionShardRootPath(), "index.json")
}

export function sessionDataPath(sessionId) {
  return path.join(sessionShardRootPath(), `${sessionId}.json`)
}

export function backgroundTaskStorePath() {
  return path.join(userRootDir(), "background-tasks.json")
}

export function backgroundTaskRuntimeDir() {
  return path.join(userRootDir(), "tasks")
}

export function backgroundTaskLogPath(taskId) {
  return path.join(backgroundTaskRuntimeDir(), `${taskId}.log`)
}

export function backgroundTaskCheckpointPath(taskId) {
  return path.join(backgroundTaskRuntimeDir(), `${taskId}.json`)
}

export function sessionCheckpointRootPath() {
  return path.join(userRootDir(), "checkpoints")
}

export function sessionCheckpointPath(sessionId, name = "latest") {
  return path.join(sessionCheckpointRootPath(), sessionId, `${name}.json`)
}

export function legacySessionStorePath() {
  return path.join(userRootDir(), "session-store.json")
}

export function reviewRejectionQueuePath(cwd = process.cwd()) {
  return path.join(projectRootDir(cwd), "review-rejections.json")
}

export function eventLogPath() {
  return path.join(userRootDir(), "events.log")
}

export function auditStorePath() {
  return path.join(userRootDir(), "audit-log.json")
}

export async function ensureUserRoot() {
  await mkdir(userRootDir(), { recursive: true })
}

export async function ensureProjectRoot(cwd = process.cwd()) {
  await mkdir(projectRootDir(cwd), { recursive: true })
}

export async function ensureSessionShardRoot() {
  await mkdir(sessionShardRootPath(), { recursive: true })
}

export async function ensureBackgroundTaskRuntimeDir() {
  await mkdir(backgroundTaskRuntimeDir(), { recursive: true })
}

// Auto Memory — persistent per-project memory directory
export function memoryDir(cwd = process.cwd()) {
  const hash = createHash("md5").update(cwd).digest("hex").slice(0, 12)
  const safeName = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30)
  return path.join(userRootDir(), "projects", `${safeName}_${hash}`, "memory")
}

export function memoryFilePath(cwd = process.cwd()) {
  return path.join(memoryDir(cwd), "MEMORY.md")
}

export async function ensureMemoryDir(cwd = process.cwd()) {
  await mkdir(memoryDir(cwd), { recursive: true })
}

// GitHub integration
export function githubTokenPath() {
  return path.join(userRootDir(), "github-token.json")
}

export function githubReposDir() {
  return path.join(userRootDir(), "repos")
}

export async function ensureGithubReposDir() {
  await mkdir(githubReposDir(), { recursive: true })
}
