import path from "node:path"
import { mkdir } from "node:fs/promises"
import { readJson, writeJson } from "../storage/json-store.mjs"
import { projectRootDir } from "../storage/paths.mjs"

function statePath(cwd = process.cwd()) {
  return path.join(projectRootDir(cwd), "longagent-state.json")
}

async function ensure(cwd = process.cwd()) {
  await mkdir(projectRootDir(cwd), { recursive: true })
}

async function read(cwd = process.cwd()) {
  await ensure(cwd)
  return readJson(statePath(cwd), { sessions: {} })
}

async function write(data, cwd = process.cwd()) {
  await ensure(cwd)
  await writeJson(statePath(cwd), data)
}

export const LongAgentManager = {
  async update(sessionId, patch, cwd = process.cwd()) {
    const state = await read(cwd)
    const current = state.sessions[sessionId] || {
      sessionId,
      status: "idle",
      phase: "L0",
      gateStatus: {},
      currentGate: "execution",
      recoveryCount: 0,
      planFrozen: false,
      currentStageId: null,
      stageIndex: 0,
      stageCount: 0,
      stageStatus: null,
      taskProgress: {},
      remainingFiles: [],
      remainingFilesCount: 0,
      lastGateFailures: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      heartbeatAt: null,
      iterations: 0,
      lastMessage: ""
    }
    state.sessions[sessionId] = {
      ...current,
      ...patch,
      updatedAt: Date.now()
    }
    await write(state, cwd)
    return state.sessions[sessionId]
  },
  async get(sessionId, cwd = process.cwd()) {
    const state = await read(cwd)
    return state.sessions[sessionId] || null
  },
  async list(cwd = process.cwd()) {
    const state = await read(cwd)
    return Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt)
  },
  async stop(sessionId, cwd = process.cwd()) {
    const existing = await this.get(sessionId, cwd)
    if (!existing) return null
    return this.update(sessionId, { stopRequested: true }, cwd)
  },
  async clearStop(sessionId, cwd = process.cwd()) {
    const existing = await this.get(sessionId, cwd)
    if (!existing) return null
    return this.update(sessionId, { stopRequested: false }, cwd)
  }
}
