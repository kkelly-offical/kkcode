import { access } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"

const rootDir = process.cwd()
const tsconfigPath = path.join(rootDir, 'tsconfig.json')

// tsconfig.json 是常驻门槛（0.9.1 起白名单 130 个文件，1.0.0 类型清扫后 154 个）。
// 它缺失只可能是被误删 —— 这里曾静默跳过并 exit 0，typecheck 这一步会假绿；
// 现在改为硬失败。
try {
  await access(tsconfigPath)
} catch {
  console.error('typecheck failed: tsconfig.json not found (it is a permanent release gate; restore it)')
  process.exit(1)
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
