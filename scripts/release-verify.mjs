import { spawn } from "node:child_process"

const steps = [
  { label: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  // 1.0.0 阶段 4（M8 建议的 CI 常驻）：静态 import 环检测进发布门槛。
  // 边界检查（check-boundaries）已由 npm run lint 覆盖，这里不重复挂。
  { label: 'import cycles', cmd: 'node', args: ['scripts/check-import-cycles.mjs'] },
  { label: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { label: 'Web typecheck', cmd: 'npm', args: ['run', 'typecheck:web'] },
  { label: 'bundled Web build', cmd: 'npm', args: ['run', 'build:web'] },
  { label: 'secret scan', cmd: 'npm', args: ['run', 'security:scan'] },
  { label: 'coverage', cmd: 'npm', args: ['run', 'coverage'] },
  { label: 'test:e2e', cmd: 'npm', args: ['run', 'test:e2e'] },
  { label: 'package smoke', cmd: 'npm', args: ['run', 'package:smoke'] }
]

for (const step of steps) {
  console.log(`==> ${step.label}`)
  await new Promise((resolve, reject) => {
    const child = spawn(step.cmd, step.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${step.label} failed with exit code ${code}`)))
    child.on('error', reject)
  })
}
