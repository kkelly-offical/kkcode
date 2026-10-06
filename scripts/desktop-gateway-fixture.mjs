import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// Ephemeral loopback TLS fixture only. No certificate or trust change ships in
// the application, and no system certificate store is modified by this test.
export async function gatewayFixture(directory) {
  let openssl = 'openssl'
  const gitOpenSsl = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')
  try { await access(gitOpenSsl); openssl = gitOpenSsl } catch { /* Use the runner's OpenSSL command. */ }
  const key = path.join(directory, 'fixture.key'), cert = path.join(directory, 'fixture.crt')
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=KK Code isolated test', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8', windowsHide: true })
  assert.equal(generated.status, 0, 'Could not generate the isolated TLS test certificate')
  const certificate = await readFile(cert, 'utf8'), seen = []
  const server = createServer({ key: await readFile(key), cert: certificate }, async (req, res) => {
    const pathname = new URL(req.url, 'https://127.0.0.1').pathname
    seen.push(pathname)
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    if (pathname === '/api/v1/discovery') return json({ version: 'fixture-old-gateway' })
    if (pathname === '/api/v1/profile') return json({ name: 'Gateway fixture', organization: 'Isolated test' })
    if (pathname === '/api/v1/devices') return json([])
    if (pathname === '/auth/fixture') {
      let body = ''; for await (const chunk of req) body += chunk
      res.setHeader('Set-Cookie', 'fixture=allowed; Secure; HttpOnly; SameSite=Strict; Path=/')
      return json({ method: req.method, body })
    }
    if (pathname === '/api/v1/fixture-cookie') return json({ cookie: req.headers.cookie || '' })
    if (pathname === '/api/v1/fixture-stream') {
      res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders()
      res.write('data: first\n\n')
      const timer = setTimeout(() => res.end('data: second\n\n'), 200)
      res.on('close', () => clearTimeout(timer)); return
    }
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>OLD GATEWAY UI</h1>'); return }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `https://127.0.0.1:${server.address().port}`, certificate, seen, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
