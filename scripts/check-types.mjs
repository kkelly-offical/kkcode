import { access } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"

const rootDir = process.cwd()
const tsconfigPath = path.join(rootDir, 'tsconfig.json')

try {
  await access(tsconfigPath)
} catch {
  console.log('typecheck skipped: no tsconfig.json')
  process.exit(0)
}

await new Promise((resolve, reject) => {
  const child = spawn('npx', ['tsc', '--noEmit'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`typecheck failed with exit code ${code}`)))
  child.on('error', reject)
})
