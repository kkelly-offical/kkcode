import { readdir } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

const rootDir = process.cwd()
const targets = ["src", "test", "scripts"]
const syntaxTargets = []

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collect(full)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
      syntaxTargets.push(full)
    }
  }
}

for (const rel of targets) {
  await collect(path.join(rootDir, rel))
}

for (const file of syntaxTargets.sort()) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { cwd: rootDir, stdio: 'inherit' })
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`syntax check failed: ${file}`)))
    child.on('error', reject)
  })
}

console.log(`syntax ok: ${syntaxTargets.length} files`)
