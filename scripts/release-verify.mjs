import { spawn } from "node:child_process"

const steps = [
  { label: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  { label: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { label: 'test', cmd: 'npm', args: ['test'] },
  { label: 'test:e2e', cmd: 'npm', args: ['run', 'test:e2e'] },
  { label: 'pack', cmd: 'npm', args: ['pack', '--dry-run'] }
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
