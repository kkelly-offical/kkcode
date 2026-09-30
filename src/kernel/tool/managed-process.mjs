import { spawn } from 'node:child_process'
import path from 'node:path'

/** A bounded, single-attempt process owner. POSIX children share a new process
 * group; Windows uses the native taskkill tree operation without changing OS
 * policy. This is lifecycle management, not an isolation/security boundary:
 * intentionally daemonized/detached descendants need the strict OCI runtime. */
export function runManagedProcess({ command, args = [], cwd, env = process.env, shell = false,
  signal = null, timeoutMs = 120000, maxBuffer = 1024 * 1024, killGraceMs = 250, drainMs = 1000 }) {
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }
    const limit = Math.max(1, Number(maxBuffer) || 1024 * 1024)
    let child, exitCode = null, exitSignal = null, errorCode = null, errorMessage = ''
    let started = false, timedOut = false, cancelled = false, captureIncomplete = false, terminationIncomplete = false
    let closed = false, stopping = false, terminationDone = false, settled = false
    let timeout, escalation, drain, deadline
    const finish = () => {
      if (settled) return
      settled = true
      for (const timer of [timeout, escalation, drain, deadline]) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child?.stdout?.destroy(); child?.stderr?.destroy()
      child?.unref()
      resolve({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        exitCode, exitSignal, timedOut, cancelled, captureIncomplete, terminationIncomplete, started, errorCode, errorMessage })
    }
    const maybeFinish = () => { if (closed && (!stopping || terminationDone)) finish() }
    const ownedGroupExists = () => {
      if (process.platform === 'win32' || !child?.pid) return false
      try { process.kill(-child.pid, 0); return true }
      catch (error) { return error.code !== 'ESRCH' }
    }
    const killGroup = killSignal => {
      if (!child?.pid) return
      try { process.kill(-child.pid, killSignal) }
      catch (error) { if (error.code !== 'ESRCH') terminationIncomplete = true }
    }
    const stop = reason => {
      if (settled || stopping) return
      stopping = true
      timedOut = reason === 'timeout'
      cancelled = reason === 'cancelled'
      if (reason === 'capture') captureIncomplete = true
      clearTimeout(timeout); clearTimeout(drain)
      if (!child?.pid) { terminationDone = true; maybeFinish(); return }
      // Always escalate the owned group even if the shell closes its pipes
      // early: a descendant can ignore TERM and redirect/close its own output.
      if (process.platform !== 'win32') {
        killGroup('SIGTERM')
        escalation = setTimeout(() => { killGroup('SIGKILL'); terminationDone = true; maybeFinish() }, killGraceMs)
      } else {
        const failedTreeStop = () => { terminationIncomplete = true; try { child.kill('SIGKILL') } catch { /* retained as unknown */ } }
        try {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          const killerDeadline = setTimeout(() => { failedTreeStop(); killer.kill(); killer.unref() }, drainMs)
          killer.once('error', () => { failedTreeStop(); clearTimeout(killerDeadline); terminationDone = true; maybeFinish() })
          killer.once('close', code => { clearTimeout(killerDeadline); if (code !== 0) failedTreeStop(); terminationDone = true; maybeFinish() })
        } catch {
          failedTreeStop(); terminationDone = true; maybeFinish()
        }
      }
      deadline = setTimeout(() => {
        if (!closed) { captureIncomplete = true; terminationIncomplete = true }
        if (!terminationDone) terminationIncomplete = true
        finish()
      }, killGraceMs + drainMs)
    }
    const onAbort = () => stop('cancelled')
    if (signal?.aborted) { cancelled = true; finish(); return }
    try {
      child = spawn(command, args, { cwd, env, shell, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      errorCode = error.code || 'PROCESS_SPAWN_FAILED'; errorMessage = error.message; finish(); return
    }
    child.once('spawn', () => { started = true })
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const keep = Math.max(0, Math.min(chunk.length, limit - sizes[stream]))
      if (keep) { chunks[stream].push(chunk.subarray(0, keep)); sizes[stream] += keep }
      if (keep < chunk.length) { errorCode = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'; stop('capture') }
    })
    child.once('error', error => { errorCode = error.code || 'PROCESS_FAILED'; errorMessage = error.message })
    child.once('exit', (code, processSignal) => {
      exitCode = Number.isInteger(code) ? code : null; exitSignal = processSignal || null
      if (!stopping) drain = setTimeout(() => stop('capture'), drainMs)
    })
    child.once('close', (code, processSignal) => {
      closed = true; exitCode = Number.isInteger(code) ? code : null; exitSignal = processSignal || exitSignal
      clearTimeout(drain)
      // Reaped shell + closed pipes do not prove that its ordinary children
      // exited: `command &` can redirect every inherited pipe. Never silently
      // orphan that owned group or claim its unobserved exits were successful.
      if (!stopping && ownedGroupExists()) {
        // Sandbox monitors may need a final scheduling turn to exit. Keep
        // ownership during a bounded drain instead of calling them orphans
        // immediately. Once the group disappears, never target that ID again.
        const drainDeadline = Date.now() + drainMs
        const checkGroup = () => {
          if (settled || stopping) return
          if (!ownedGroupExists()) { finish(); return }
          if (Date.now() >= drainDeadline) {
            errorCode = 'PROCESS_CHILDREN_RUNNING'
            errorMessage = 'Child processes outlived the command. Remove manual shell backgrounding and use run_in_background: true for a managed long-running command.'
            stop('capture')
          } else drain = setTimeout(checkGroup, Math.min(20, drainDeadline - Date.now()))
        }
        drain = setTimeout(checkGroup, Math.min(20, drainMs))
        return
      }
      maybeFinish()
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (!stopping && Number.isFinite(timeoutMs) && timeoutMs > 0) timeout = setTimeout(() => stop('timeout'), timeoutMs)
  })
}
