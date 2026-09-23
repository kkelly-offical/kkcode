import dns from 'node:dns/promises'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import WebSocket from 'ws'
import { blockedIpReason } from '../../net/url-guard.mjs'

const metadataHosts = new Set(['metadata', 'metadata.google.internal', 'metadata.goog'])
function canonicalIp(address) {
  if (net.isIP(address) !== 6) return address
  const value = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(value)
  if (!mapped) return value
  const upper = parseInt(mapped[1], 16), lower = parseInt(mapped[2], 16)
  return [upper >>> 8, upper & 255, lower >>> 8, lower & 255].join('.')
}
function alwaysPrivate(address) {
  const ip = canonicalIp(address)
  return ip.startsWith('169.254.') || ip === '100.100.100.200' || ip === 'fd00:ec2::254' || ip.startsWith('fe80:') || ip === '0.0.0.0' || ip === '::'
}

/** Every HTTP resource is fetched by Node with an IP-pinned lookup, then served
 * to the browser's intercepted request. Chromium's fallback proxy denies all
 * unhandled network traffic. No DNS-check-then-browser-resolves-again race. */
export class BrowserNetwork {
  constructor({ lookup = (host => dns.lookup(host, { all: true })), maxBytes = 64 * 1024 * 1024, maxRequests = 500 } = {}) {
    this.lookup = lookup; this.maxBytes = maxBytes; this.maxRequests = maxRequests
    this.privateOrigins = new Map(); this.bytes = 0; this.requests = 0; this.errors = []; this.controller = new AbortController()
    this.sockets = new Set()
  }
  async target(raw, explicit = false) {
    const url = new URL(String(raw))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Browser permits HTTP(S) URLs without embedded credentials only')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (metadataHosts.has(host)) throw new Error('Cloud metadata endpoints are never available to Browser')
    const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await this.lookup(host)
    if (!addresses.length || addresses.some(item => alwaysPrivate(item.address))) throw new Error('Browser refuses metadata, link-local and unspecified addresses')
    const privateAddresses = addresses.filter(item => blockedIpReason(canonicalIp(item.address)))
    if (explicit && privateAddresses.length) this.privateOrigins.set(url.origin, new Set(addresses.map(item => canonicalIp(item.address))))
    const allowed = this.privateOrigins.get(url.origin)
    if (privateAddresses.some(item => !allowed?.has(canonicalIp(item.address)))) throw new Error('Private subresource or redirect blocked; explicitly open that development origin first')
    return { url, address: addresses[0] }
  }
  /** @param {string} raw @param {{method?: string, headers?: Record<string, string>, body?: Buffer|null, signal?: AbortSignal|null}} [options] */
  async fetch(raw, { method = 'GET', headers = {}, body = null, signal = null } = {}) {
    if (++this.requests > this.maxRequests) throw new Error('Browser request budget exhausted; close and reopen the browser session')
    const { url, address } = await this.target(raw)
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('Unsupported browser HTTP method')
    if (body && Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Browser request body exceeds 4 MiB')
    const cleanHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => !['host', 'connection', 'proxy-connection', 'proxy-authorization', 'content-length', 'accept-encoding'].includes(name.toLowerCase())))
    cleanHeaders['accept-encoding'] = 'identity'
    const abort = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers: cleanHeaders, signal: abort, timeout: 15000,
        lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)
      }, response => {
        const chunks = []; let size = 0
        response.on('data', chunk => {
          size += chunk.length; this.bytes += chunk.length
          if (size > 16 * 1024 * 1024 || this.bytes > this.maxBytes) { response.destroy(new Error('Browser response exceeds its byte budget')); return }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const resultHeaders = {}
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && !['transfer-encoding', 'connection', 'content-length'].includes(key)) resultHeaders[key] = Array.isArray(value) ? value.join('\n') : value
          resolve({ status: response.statusCode || 502, headers: resultHeaders, body: Buffer.concat(chunks) })
        })
      })
      request.on('timeout', () => request.destroy(new Error('Browser resource request timed out')))
      request.on('error', reject)
      if (body) request.write(body)
      request.end()
    })
  }
  /** Development-only WebSockets use the same DNS pinning and byte budget as
   * HTTP. No redirect, proxy fallback, metadata access or cross-origin socket. */
  async websocket(raw, { origin, protocol = '' }) {
    const url = new URL(raw)
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Expected a WebSocket URL')
    const httpUrl = new URL(url); httpUrl.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    if (httpUrl.origin !== origin) throw new Error('Development WebSocket must use the explicitly opened page origin')
    if (protocol && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(protocol)) throw new Error('Invalid WebSocket subprotocol')
    if (this.sockets.size >= 8 || ++this.requests > this.maxRequests) throw new Error('Browser WebSocket budget exhausted')
    const { address } = await this.target(httpUrl.href)
    this.controller.signal.throwIfAborted()
    const socket = new WebSocket(url, protocol ? [protocol] : [], {
      followRedirects: false, handshakeTimeout: 10000, maxPayload: 1024 * 1024,
      origin, perMessageDeflate: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)
    })
    this.sockets.add(socket)
    const abort = () => socket.terminate()
    this.controller.signal.addEventListener('abort', abort, { once: true })
    socket.once('close', () => { this.sockets.delete(socket); this.controller.signal.removeEventListener('abort', abort) })
    socket.on('error', () => {})
    await new Promise((resolve, reject) => { socket.once('open', () => resolve(undefined)); socket.once('error', reject); socket.once('close', () => reject(new Error('WebSocket closed before connecting'))) })
    return socket
  }
  countSocketBytes(data) {
    const bytes = Buffer.byteLength(data); this.bytes += bytes
    if (bytes > 1024 * 1024 || this.bytes > this.maxBytes) throw new Error('Browser WebSocket byte budget exhausted')
  }
  close() { this.controller.abort(); for (const socket of this.sockets) socket.terminate(); this.sockets.clear(); this.privateOrigins.clear() }
}

export async function createDenyProxy() {
  const server = http.createServer((_request, response) => { response.writeHead(403); response.end('Browser network requires interception') })
  server.on('connect', (_request, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)) })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
