import { request as httpRequest } from 'node:http'

/** Accept HTTP origin-form only; never interpret request-target as a URL. */
export function originFormPath(target) {
  if (typeof target !== 'string' || !/^\/(?!\/)[\x21-\x7e]*$/.test(target) || /[\\#]/.test(target) || /%(?![0-9a-f]{2})/i.test(target) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(target)) throw new TypeError('Invalid origin-form request target')
  try { decodeURI(target) } catch { throw new TypeError('Invalid request-target encoding') }
  return target
}

/** Lab-only proxy: authority is fixed independently of all incoming request data. */
export function createLoopbackProxy(backendPort) {
  if (!Number.isSafeInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new TypeError('A fixed loopback backend port is required')
  return (req, res) => {
    let requestPath
    try { requestPath = originFormPath(req.url) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ error: 'Invalid request target' }))
      return
    }
    // Explicit connection fields make SSRF impossible even if path validation
    // is later changed. Do not replace this with new URL(req.url, backend).
    const forward = httpRequest({ protocol: 'http:', hostname: '127.0.0.1', port: backendPort, path: requestPath, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    forward.on('error', () => { if (!res.headersSent) { res.writeHead(503); res.end() } else res.destroy() })
    req.on('aborted', () => forward.destroy())
    req.pipe(forward)
  }
}
