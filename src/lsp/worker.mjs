// Standalone subprocess worker: also evaluated inside the strict read-only container.
// Only Node builtins here; no project imports, shell, package installation or edits.
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readPinnedFile } from '../util/pinned-io.mjs'

const MAX_FRAME = 8 * 1024 * 1024
const MAX_TOTAL = 16 * 1024 * 1024
const failure = (code, message) => Object.assign(new Error(message), { code })

async function main() {
  const chunks = []; let received = 0
  for await (const chunk of process.stdin) {
    received += chunk.length
    if (received > 4 * 1024 * 1024) throw failure('LSP_LIMIT', '语言服务输入超过安全上限。')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || !['diagnostics', 'symbols', 'definition', 'references'].includes(input.operation) ||
      typeof input.command !== 'string' || !path.isAbsolute(input.command) || !Array.isArray(input.args) ||
      input.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || (input.collectSource !== true && typeof input.text !== 'string') ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120000) throw failure('LSP_INVALID', '语言服务执行请求无效。')
  const workspace = process.cwd()
  const target = path.resolve(workspace, input.path)
  const relative = path.relative(workspace, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('LSP_SCOPE', '语言服务文件必须在当前工作区内。')
  let sourceHash = null
  const collect = () => readPinnedFile(workspace, relative.split(path.sep).join('/'), { maxBytes: 2 * 1024 * 1024 })
  if (input.collectSource === true) {
    const bytes = await collect()
    input.text = bytes.toString('utf8')
    sourceHash = createHash('sha256').update(bytes).digest('hex')
    if (input.position) {
      const lines = input.text.split('\n'), { line, character } = input.position
      if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0 || line >= lines.length || character > lines[line].replace(/\r$/, '').length) throw failure('LSP_POSITION', '查询位置超出隔离采集的当前文件。')
    }
  }
  const uri = pathToFileURL(target).href, rootUri = pathToFileURL(workspace).href
  const child = spawn(input.command, input.args, { cwd: workspace, shell: false, windowsHide: true,
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let nextId = 0, buffer = Buffer.alloc(0), total = 0, failed = null, shutdown = false
  const pending = new Map(), diagnostics = new Map(), listeners = new Set()
  function send(message) {
    if (child.stdin.destroyed) throw failure('LSP_CLOSED', '语言服务通道已关闭。')
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  function stop(error) {
    failed ||= error
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failed) }
    pending.clear()
    for (const listener of listeners) listener(failed)
    listeners.clear()
    child.kill('SIGTERM')
  }
  child.stdin.on('error', () => stop(failure('LSP_CLOSED', '语言服务输入通道不可用。')))
  child.on('error', () => stop(failure('LSP_UNAVAILABLE', '已批准的语言服务器无法启动，请检查安装和绝对路径。')))
  child.on('close', () => { if (!shutdown) stop(failure('LSP_CLOSED', '语言服务器提前退出，结果不完整。')) })
  child.stderr.on('data', chunk => { total += chunk.length; if (total > MAX_TOTAL) stop(failure('LSP_LIMIT', '语言服务器输出超过安全上限。')) })
  child.stdout.on('data', chunk => {
    try {
      total += chunk.length
      if (total > MAX_TOTAL || buffer.length + chunk.length > MAX_FRAME + 8192) throw failure('LSP_LIMIT', '语言服务器输出超过安全上限。')
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const separator = buffer.indexOf('\r\n\r\n')
        if (separator < 0) { if (buffer.length > 8192) throw failure('LSP_PROTOCOL', '语言服务消息头无效。'); break }
        if (separator > 8192) throw failure('LSP_PROTOCOL', '语言服务消息头过长。')
        const header = buffer.subarray(0, separator).toString('ascii')
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
        if (lengths.length !== 1) throw failure('LSP_PROTOCOL', '语言服务缺少唯一的 Content-Length。')
        const size = Number(lengths[0][1])
        if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FRAME) throw failure('LSP_LIMIT', '语言服务消息超过安全上限。')
        if (buffer.length < separator + 4 + size) break
        const message = JSON.parse(buffer.subarray(separator + 4, separator + 4 + size).toString('utf8'))
        buffer = buffer.subarray(separator + 4 + size)
        if (!message || message.jsonrpc !== '2.0') throw failure('LSP_PROTOCOL', '语言服务返回无效 JSON-RPC。')
        if (message.method && message.id !== undefined) {
          if (message.method === 'workspace/configuration') {
            const items = message.params?.items
            send({ id: message.id, result: Array.isArray(items) ? items.slice(0, 100).map(() => null) : [] })
          } else if (message.method === 'workspace/workspaceFolders') send({ id: message.id, result: [{ uri: rootUri, name: 'workspace' }] })
          else if (message.method === 'workspace/applyEdit') send({ id: message.id, result: { applied: false, failureReason: 'KK Code LSP is read-only; editing requires the governed edit tools.' } })
          else send({ id: message.id, error: { code: -32601, message: 'Host action is not supported in read-only language inspection.' } })
        } else if (message.method === 'textDocument/publishDiagnostics') {
          if (message.params?.uri === uri && Array.isArray(message.params.diagnostics) &&
              (message.params.version === undefined || message.params.version === 1)) {
            diagnostics.set(uri, message.params)
            for (const listener of listeners) listener(null)
          }
        } else if (message.id !== undefined && pending.has(message.id)) {
          const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer)
          if (message.error) item.reject(failure(message.error.code === -32601 ? 'LSP_UNSUPPORTED' : 'LSP_SERVER_ERROR', '语言服务器未能执行请求，未将失败当成无诊断。'))
          else if (!Object.hasOwn(message, 'result')) item.reject(failure('LSP_PROTOCOL', '语言服务响应缺少 result。'))
          else item.resolve(message.result)
        }
      }
    } catch (error) { stop(error.code?.startsWith('LSP_') ? error : failure('LSP_PROTOCOL', '语言服务帧或 JSON 格式无效。')) }
  })
  function request(method, params, timeoutMs = input.timeoutMs) {
    if (failed) return Promise.reject(failed)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { send({ method: '$/cancelRequest', params: { id } }) } catch {}
        pending.delete(id)
        reject(failure('LSP_TIMEOUT', '语言服务超时；该结果不能作为验收通过证据。'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try { send({ id, method, params }) } catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }
  const abort = () => stop(failure('LSP_CANCELLED', '语言服务查询已取消。'))
  process.on('SIGTERM', abort)
  const deadline = setTimeout(() => stop(failure('LSP_TIMEOUT', '语言服务总执行时限已耗尽。')), input.timeoutMs)
  try {
    const initialized = await request('initialize', {
      processId: null, rootUri, workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { applyEdit: false, workspaceFolders: true },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { versionSupport: true, relatedInformation: false },
          diagnostic: { dynamicRegistration: false } } },
      initializationOptions: input.initializationOptions || {}
    })
    if (initialized?.capabilities?.positionEncoding && initialized.capabilities.positionEncoding !== 'utf-16') throw failure('LSP_UNSUPPORTED', '语言服务器未选择支持的 UTF-16 位置编码。')
    send({ method: 'initialized', params: {} })
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: input.language, version: 1, text: input.text } } })
    let result, diagnosticMode = null
    if (input.operation === 'diagnostics') {
      if (initialized?.capabilities?.diagnosticProvider) {
        const response = await request('textDocument/diagnostic', { textDocument: { uri } })
        if (response?.kind !== 'full' || !Array.isArray(response.items)) throw failure('LSP_PROTOCOL', '首次诊断未返回完整结果。')
        result = response.items; diagnosticMode = 'pull_full'
      } else if (/^(typescript|javascript)(react)?$/.test(input.language) && Array.isArray(initialized?.capabilities?.executeCommandProvider?.commands) && initialized.capabilities.executeCommandProvider.commands.includes('typescript.tsserverRequest')) {
        // The approved TypeScript LSP publishes empty clearing notifications
        // before semantic analysis. Never mistake that first [] for a complete
        // result. Its documented extension provides fixed read-only barriers;
        // no arbitrary executeCommand name/args are exposed to model callers.
        const lines = input.text.split('\n'), seen = new Set()
        result = []
        const point = value => {
          if (!Number.isSafeInteger(value?.line) || !Number.isSafeInteger(value?.offset) || value.line < 1 || value.line > lines.length || value.offset < 1 || value.offset - 1 > lines[value.line - 1].replace(/\r$/, '').length) throw failure('LSP_PROTOCOL', 'TypeScript 诊断位置超出当前源码。')
          return { line: value.line - 1, character: value.offset - 1 }
        }
        for (const command of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync', 'suggestionDiagnosticsSync']) {
          const response = await request('workspace/executeCommand', { command: 'typescript.tsserverRequest', arguments: [command, { file: uri }, { expectsResult: true }] })
          if (response?.success !== true || response.command !== command || !Array.isArray(response.body)) throw failure('LSP_PROTOCOL', 'TypeScript 同步诊断未返回完整成功回执。')
          for (const item of response.body) {
            if (typeof item.text !== 'string') throw failure('LSP_PROTOCOL', 'TypeScript 诊断缺少有效消息。')
            const start = point(item.start), end = point(item.end)
            if (end.line < start.line || end.line === start.line && end.character < start.character) throw failure('LSP_PROTOCOL', 'TypeScript 诊断范围倒置。')
            const diagnostic = { range: { start, end }, message: item.text, severity: item.category === 'warning' ? 2 : item.category === 'suggestion' ? 4 : 1, code: item.code, source: 'typescript' }
            const key = JSON.stringify(diagnostic)
            if (!seen.has(key)) { seen.add(key); result.push(diagnostic) }
          }
        }
        diagnosticMode = 'typescript_sync'
      } else {
        if (!diagnostics.has(uri)) await new Promise(/** @param {(value?: void) => void} resolve */ (resolve, reject) => {
          const timer = setTimeout(() => { listeners.delete(listener); reject(failure('LSP_TIMEOUT', '未收到此文件的诊断通知，不能视为没有错误。')) }, input.timeoutMs)
          const listener = error => { clearTimeout(timer); listeners.delete(listener); error ? reject(error) : resolve(undefined) }
          listeners.add(listener)
          if (failed) listener(failed)
        })
        result = diagnostics.get(uri).diagnostics; diagnosticMode = 'push_snapshot'
      }
    } else {
      const methods = { symbols: 'textDocument/documentSymbol', definition: 'textDocument/definition', references: 'textDocument/references' }
      const params = { textDocument: { uri }, ...(input.operation === 'symbols' ? {} : { position: input.position }),
        ...(input.operation === 'references' ? { context: { includeDeclaration: true } } : {}) }
      result = await request(methods[input.operation], params)
    }
    if (input.collectSource === true && createHash('sha256').update(await collect()).digest('hex') !== sourceHash) throw failure('LSP_SOURCE_CHANGED', '查询期间源码发生变化，隔离结果已失效。')
    return { ok: true, result, diagnosticMode, workspaceUri: rootUri, documentUri: uri, sourceHash }
  } finally {
    clearTimeout(deadline)
    shutdown = true
    try { if (!failed) { await request('shutdown', null, 200); send({ method: 'exit' }) } } catch {}
    child.stdin.end()
    if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
      // A language server can own TS/Java children. Stop its owned tree while
      // its PID still exists; do not leave them behind after a host query.
      await new Promise(/** @param {(value?: void) => void} resolve */ resolve => {
        const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR
        if (!root) { child.kill('SIGTERM'); resolve(undefined); return }
        const killer = spawn(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        const timer = setTimeout(() => { killer.kill(); resolve(undefined) }, 1000)
        killer.once('error', () => { clearTimeout(timer); resolve(undefined) })
        killer.once('close', () => { clearTimeout(timer); resolve(undefined) })
      })
    }
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 200)
    await new Promise(/** @param {(value?: void) => void} resolve */ resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()) })
    clearTimeout(kill)
    process.removeListener('SIGTERM', abort)
  }
}

try { process.stdout.write(JSON.stringify(await main())) } catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: typeof error.code === 'string' && error.code.startsWith('LSP_') ? error.code : 'LSP_FAILED',
    message: typeof error.code === 'string' && error.code.startsWith('LSP_') ? error.message : '语言服务执行失败，未返回可信结果。' }))
}
