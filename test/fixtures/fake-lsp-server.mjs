// Synthetic stdio LSP server for local contract tests; never a shipped server.
const flags = new Set(process.argv.slice(2))
let buffer = Buffer.alloc(0), uri, version = 1, rejectedEdit = false, openedText = ''
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
  const data = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
  if (flags.has('--fragment')) { for (let i = 0; i < data.length; i += 7) process.stdout.write(data.subarray(i, i + 7)) }
  else process.stdout.write(data)
}
function receive(message) {
  if (message.id === 999 && message.result) { rejectedEdit = message.result.applied === false; return }
  if (message.method === 'initialize') {
    if (flags.has('--require-push-capability') && message.params?.capabilities?.textDocument?.publishDiagnostics?.versionSupport !== true) {
      send({ id: message.id, error: { code: -32602, message: 'push diagnostics capability was not advertised' } }); return
    }
    if (flags.has('--malformed')) { process.stdout.write('Content-Length: 999999999\r\n\r\n'); return }
    if (flags.has('--hang')) return
    send({ id: 999, method: 'workspace/applyEdit', params: { edit: { changes: {} } } })
    send({ id: message.id, result: { capabilities: { positionEncoding: 'utf-16',
      ...(flags.has('--ts-sync') ? { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } } : {}),
      ...(flags.has('--push') ? {} : { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }) } } })
  } else if (message.method === 'textDocument/didOpen') {
    openedText = message.params.textDocument.text
    uri = message.params.textDocument.uri
    version = message.params.textDocument.version
    if (flags.has('--push')) send({ method: 'textDocument/publishDiagnostics', params: {
      uri, version: flags.has('--stale') ? version - 1 : version, diagnostics: flags.has('--ts-sync') ? [] : [{ range, severity: 1, message: 'synthetic diagnostic', source: 'fixture' }]
    } })
  } else if (message.method === 'workspace/executeCommand' && flags.has('--ts-sync')) {
    const [command, target] = message.params.arguments || []
    if (message.params.command !== 'typescript.tsserverRequest' || !['syntacticDiagnosticsSync', 'semanticDiagnosticsSync', 'suggestionDiagnosticsSync'].includes(command) || target.file !== uri) {
      send({ id: message.id, error: { code: -32602, message: 'unexpected non-read-only command' } }); return
    }
    send({ id: message.id, result: { command, success: !flags.has('--ts-sync-fail'), body: command === 'semanticDiagnosticsSync' ? [{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 }, text: 'full semantic diagnostic', category: 'error', code: 2322 }] : [] } })
  } else if (message.method === 'textDocument/diagnostic') {
    if (flags.has('--slow')) return
    send({ id: message.id, result: { kind: 'full', items: [{ range, severity: 1, message: 'synthetic diagnostic', source: 'fixture' }] } })
  } else if (message.method === 'textDocument/documentSymbol') {
    send({ id: message.id, result: [{ name: flags.has('--echo-source') ? openedText : flags.has('--env') ? `secret=${Boolean(process.env.KK_LSP_SECRET || process.env.NODE_OPTIONS)}` : rejectedEdit ? 'readOnlySymbol' : 'unsafe', kind: 12, range, selectionRange: range }] })
  } else if (['textDocument/definition', 'textDocument/references'].includes(message.method)) {
    send({ id: message.id, result: [{ uri, range }, { uri: 'file:///etc/passwd', range }] })
  } else if (message.method === 'shutdown') send({ id: message.id, result: null })
  else if (message.method === 'exit') process.exit(0)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + size) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString())
    buffer = buffer.subarray(end + 4 + size)
    receive(message)
  }
})
