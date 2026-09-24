import path from 'node:path'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open } from 'node:fs/promises'
import { userRootDir } from '../../src/storage/paths.mjs'

export function sanitizeDiagnostic(value, secrets = [], limit = 4000) {
  let text = String(value ?? '')
  const variants = secrets.filter(secret => typeof secret === 'string' && secret).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])
  for (const secret of [...new Set(variants)].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
  text = text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(["']?(?:api_key|access_token|password|authorization)["']?\s*[:=]\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '?')
  return text.slice(0, limit)
}

export const evaluationDiagnosticRoot = () => path.join(userRootDir(), 'evaluation-diagnostics')

export function evaluationTurnDiagnostics(turns, secrets = []) {
  return turns.filter(turn => turn?.error).map(turn => sanitizeDiagnostic(turn.error, secrets, 4000))
}

export async function writeEvaluationDiagnostic({ root = evaluationDiagnosticRoot(), error, taskId, secrets = [] }) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o077)) throw new Error('Private evaluation diagnostic directory is not private')
  const diagnosticId = `diag_${randomUUID()}`
  const value = { schema: 'kk.evaluation.diagnostic.v1', diagnosticId, taskId, createdAt: new Date().toISOString(),
    code: sanitizeDiagnostic(error?.code || error?.name || 'EVALUATION_ERROR', secrets, 100),
    message: sanitizeDiagnostic(error?.message || error, secrets, 4000), stack: sanitizeDiagnostic(error?.stack || '', secrets, 8000),
    stderr: sanitizeDiagnostic(error?.stderr || '', secrets, 4000) }
  const handle = await open(path.join(root, `${diagnosticId}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() } finally { await handle.close() }
  return diagnosticId
}

export async function readEvaluationDiagnostic(diagnosticId, root = evaluationDiagnosticRoot()) {
  if (!/^diag_[a-f0-9-]{36}$/.test(diagnosticId || '')) throw new Error('Invalid diagnostic ID')
  const handle = await open(path.join(root, `${diagnosticId}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || process.platform !== 'win32' && (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) throw new Error('Diagnostic is not a bounded private file')
    const value = JSON.parse(await handle.readFile('utf8'))
    if (value.schema !== 'kk.evaluation.diagnostic.v1' || value.diagnosticId !== diagnosticId) throw new Error('Diagnostic identity mismatch')
    return value
  } finally { await handle.close() }
}
