import * as oidc from 'openid-client'
import { randomBytes, randomInt, createHash, randomUUID } from 'node:crypto'
import { NATIVE_LOGIN_CAPABILITY, nativeLoginRequest, nativeLoginProof, nativeLoginReturn } from './native-login.mjs'

export const identityHash = value => createHash('sha256').update(String(value || '')).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const cookieName = 'kkcode_gateway', refreshName = 'kkcode_refresh'
const failure = (message, statusCode = 401) => Object.assign(new Error(message), { statusCode })
export function hasOrganizationRole(claims, claimPath = 'realm_access.roles', role = 'kkcode-admin') {
  let value = claims
  for (const segment of String(claimPath).split('.')) {
    if (!segment || ['__proto__', 'constructor', 'prototype'].includes(segment) || !value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return false
    value = value[segment]
  }
  return Array.isArray(value) && value.includes(role)
}

/** Gateway identity is independent of device execution and model credentials. */
export function registerIdentity({ app, store, config, origin, issuer, organization, dev, onRevoke, rolesClaim, adminRole, scopes = 'openid profile email', auditRetentionDays = 90, auditMaxRecords = 100000 }) {
  if (typeof scopes !== 'string' || !scopes.split(/\s+/).includes('openid') || /[\r\n]/.test(scopes)) throw new Error('OIDC scopes must contain openid')
  if (!Number.isSafeInteger(auditRetentionDays) || auditRetentionDays < 1 || auditRetentionDays > 3650 || !Number.isSafeInteger(auditMaxRecords) || auditMaxRecords < 100 || auditMaxRecords > 10000000) throw new Error('Gateway audit retention is outside safe limits')
  const prune = () => store.prune?.({ auditRetentionMs: auditRetentionDays * 86400000, maxAudit: auditMaxRecords }).catch(() => {})
  const cleanup = setInterval(prune, 60000); cleanup.unref?.()
  app.addHook('onReady', async () => { await prune() })
  app.addHook('onClose', async () => { clearInterval(cleanup) })
  const secure = !dev
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/login' || req.url.startsWith('/login?') || req.url.startsWith('/auth/')) {
      // Same-origin form POSTs must retain Origin. Chromium sends Origin:null
      // with no-referrer, which our CSRF boundary correctly rejects.
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY')
    }
  })
  const audit = async (action, actor, resource, result = 'ok') => store.put(`audit:${Date.now()}:${randomUUID()}`, { action, actor, resource, result, timestamp: Date.now() })
  async function issue(account, kind = 'client', existing = null) {
    const session = existing || { id: randomUUID(), accountId: account.id, kind, deviceId: null, createdAt: Date.now(), expires: Date.now() + 30 * 86400000 }
    if (!existing) await store.put(`identity-session:${session.id}`, session)
    const access = secret(), refresh = secret(), value = { sessionId: session.id, account, kind, expires: Date.now() + 3600000 }
    await store.put(`token:${identityHash(access)}`, value)
    await store.put(`refresh:${identityHash(refresh)}`, { sessionId: session.id, expires: session.expires })
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, profile: account }
  }
  function cookies(reply, credentials) {
    reply.setCookie(cookieName, credentials.access_token, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: credentials.expires_in })
    reply.setCookie(refreshName, credentials.refresh_token, { httpOnly: true, secure, sameSite: 'strict', path: '/auth', maxAge: 30 * 86400 })
  }
  async function sessionFor(id) {
    const session = await store.get(`identity-session:${id}`)
    if (!session || session.expires <= Date.now()) throw failure('Login required')
    const account = await store.get(`account:${session.accountId}`)
    if (!account || account.disabled) throw failure('Organization membership has been disabled', 403)
    if (account.organization !== organization) throw failure('Login belongs to a different organization', 403)
    return { session, account }
  }
  async function authenticate(req, kind = 'client') {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || req.cookies[cookieName]
    const value = await store.get(`token:${identityHash(token)}`)
    if (!value || value.expires <= Date.now() || value.kind !== kind) throw failure('Login required')
    return { ...value, ...await sessionFor(value.sessionId) }
  }
  async function revoke(sessionId) {
    await store.delete(`identity-session:${sessionId}`)
    for (const prefix of ['token:', 'refresh:']) for (const entry of await store.list(prefix)) if (entry.sessionId === sessionId) await store.delete(entry.key)
    onRevoke?.(sessionId)
  }
  async function revokeAccount(accountId) {
    for (const entry of await store.list('identity-session:')) if (entry.accountId === accountId) await revoke(entry.id)
  }
  app.get('/api/v1/discovery', async () => ({ protocolVersion: '1', gateway: origin, organization, authentication: { deviceAuthorization: '/auth/device', browser: '/auth/start', token: '/auth/token', issuer, nativeLogin: NATIVE_LOGIN_CAPABILITY } }))
  app.post('/auth/device', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: req => req.ip } } }, async req => {
    const native = nativeLoginRequest(req.body)
    const deviceCode = secret(), userCode = String(randomInt(10000000, 100000000))
    const active = await store.list('login-code:')
    for (const entry of active) if (entry.expires <= Date.now()) { await store.delete(entry.key); await store.delete(`login-user:${entry.userCode}`) }
    if (active.filter(entry => entry.expires > Date.now()).length >= 1000) throw failure('Too many login attempts', 429)
    const codeKey = `login-code:${identityHash(deviceCode)}`
    await store.put(codeKey, { userCode, name: String(req.body?.name || 'KK Code').slice(0, 80), kind: req.body?.kind === 'device' ? 'device' : 'client', ...(native ? { native } : {}), expires: Date.now() + 600000, lastPoll: 0 })
    await store.put(`login-user:${userCode}`, { codeKey })
    return { device_code: deviceCode, user_code: userCode, verification_uri: `${origin}/login`, verification_uri_complete: `${origin}/login?code=${userCode}`, expires_in: 600, interval: 5, ...(native ? { native_return: true } : {}) }
  })
  async function codeFor(userCode) {
    if (!/^\d{8}$/.test(String(userCode))) return null
    const mapping = await store.get(`login-user:${userCode}`)
    const value = mapping && await store.get(mapping.codeKey)
    return value?.expires > Date.now() ? { value, key: mapping.codeKey } : null
  }
  const page = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} · KK Code</title><style>body{background:#111;color:#eee;font:16px system-ui;margin:0}main{max-width:420px;margin:12vh auto;padding:24px}h1{font-size:25px}p{line-height:1.7;color:#aaa}input,button{font:inherit;border-radius:12px;padding:13px;border:1px solid #444}input{background:#222;color:white;width:90%}button{cursor:pointer;background:#eee;color:#111;margin-top:15px}a{color:#9acbff}</style><main>${body}</main></html>`
  function completedPage(reply, entry, denied = false, failed = false) {
    reply.header('Referrer-Policy', 'no-referrer')
    const target = nativeLoginReturn(entry)
    const heading = failed ? 'Login could not be completed' : denied ? 'Login cancelled' : 'Device approved'
    if (!target) return reply.type('text/html').send(page(denied ? '已取消' : '已连接', `<h1>${heading}</h1><p>返回 KK Code，${denied ? '可重新发起登录' : '连接将自动完成'}。</p><a href="/">Open WebUI</a>`))
    const nonce = secret()
    reply.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`)
    return reply.type('text/html').send(page(denied ? '登录未完成' : '返回 KK Code', `<h1>${heading}</h1><p>${failed ? '组织认证未能完成，请返回 App 重新登录。' : denied ? '你已取消授权。' : '授权已完成。'}正在返回 KK Code App。</p><p>若浏览器没有自动返回，请点击下方按钮；也可以手动切回 App。</p><a id="return-app" href="${html(target)}" style="display:inline-block;padding:14px 20px;background:#eee;color:#111;border-radius:12px;text-decoration:none">返回 KK Code App</a><p>这不是 WebUI 登录，无需继续打开网页工作台。</p><script nonce="${nonce}">setTimeout(function(){window.location.assign(document.getElementById('return-app').href)},150)</script>`))
  }
  async function endBrowserLogin(reply, flow, failed = false) {
    reply.clearCookie('kkcode_oauth_state', { path: '/auth' })
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await codeFor(flow.code)
      if (!entry || entry.value.confirmed) return reply.code(400).send('Login request expired')
      if (await store.comparePut(entry.key, entry.value, { ...entry.value, denied: true, ...(failed ? { authorizationFailed: true } : {}) })) return completedPage(reply, entry.value, true, failed)
    }
    return reply.code(409).send('Login request changed; restart login')
  }
  app.get('/login', async (req, reply) => reply.type('text/html').send(page('组织登录', `<h1>KK Code</h1><p>${html(organization)}</p><form action="/auth/start"><label>设备登录码<input name="code" value="${html(req.query.code || '')}" required pattern="[0-9]{8}" autocomplete="one-time-code"></label><button>Continue with organization SSO</button></form><p>只批准你本人发起的连接请求。</p>`)))
  app.get('/auth/start', async (req, reply) => {
    const entry = await codeFor(req.query.code)
    if (!entry) return reply.code(400).send('Login code expired')
    const state = secret(), verifier = oidc.randomPKCECodeVerifier(), nonce = secret()
    await store.put(`oidc-flow:${identityHash(state)}`, { code: entry.value.userCode, verifier, nonce, expires: Date.now() + 600000 })
    reply.setCookie('kkcode_oauth_state', state, { httpOnly: true, secure, sameSite: 'lax', path: '/auth', maxAge: 600 })
    return reply.redirect(oidc.buildAuthorizationUrl(config, { redirect_uri: `${origin}/auth/callback`, scope: scopes, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce }).href)
  })
  app.get('/auth/callback', async (req, reply) => {
    const state = String(req.query.state || '')
    if (!state || req.cookies.kkcode_oauth_state !== state) return reply.code(400).send('Invalid login state')
    const flow = await store.take(`oidc-flow:${identityHash(state)}`)
    if (!flow || flow.expires <= Date.now()) return reply.code(400).send('Invalid login state')
    if (req.query.error) return endBrowserLogin(reply, flow, req.query.error !== 'access_denied')
    let tokens
    try { tokens = await oidc.authorizationCodeGrant(config, new URL(req.url, origin), { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce }) }
    catch { return endBrowserLogin(reply, flow, true) }
    const claims = tokens.claims()
    if (!claims?.sub) return reply.code(401).send('Identity provider returned no subject')
    const account = { id: identityHash(`${issuer}\0${claims.sub}`), organization, name: claims.name || claims.preferred_username || claims.sub, email: claims.email || '', admin: hasOrganizationRole(claims, rolesClaim, adminRole), disabled: false }
    if ((await store.get(`account:${account.id}`))?.disabled) return reply.code(403).send('Organization membership disabled')
    await store.put(`account:${account.id}`, account)
    const entry = await codeFor(flow.code)
    if (!entry || entry.value.confirmed || entry.value.denied) return reply.code(400).send('Login request expired')
    const confirmation = secret()
    // Polling updates lastPoll concurrently; never overwrite a cancellation or
    // another completed confirmation with a stale callback snapshot.
    let updated = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await codeFor(flow.code)
      if (!current || current.value.confirmed || current.value.denied) break
      if (await store.comparePut(current.key, current.value, { ...current.value, account, confirmation: identityHash(confirmation) })) { updated = true; break }
    }
    if (!updated) return reply.code(409).send('Login request changed; restart login')
    const browser = await issue(account)
    cookies(reply, browser)
    reply.clearCookie('kkcode_oauth_state', { path: '/auth' })
    return reply.type('text/html').send(page('确认连接', `<h1>Confirm device</h1><p>${html(entry.value.name)}</p><p>${html(account.name)} · ${html(organization)}</p><form method="post" action="/auth/confirm"><input type="hidden" name="code" value="${flow.code}"><input type="hidden" name="confirmation" value="${confirmation}"><button>Allow this device</button></form>`))
  })
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))))
  app.post('/auth/confirm', async (req, reply) => {
    const { account } = await authenticate(req), entry = await codeFor(req.body?.code)
    if (!entry || entry.value.confirmed || entry.value.denied || entry.value.account?.id !== account.id || entry.value.confirmation !== identityHash(req.body?.confirmation || '')) return reply.code(403).send('Confirmation denied')
    const value = { ...entry.value, confirmed: true }; delete value.confirmation
    if (!await store.comparePut(entry.key, entry.value, value)) return reply.code(409).send('Login request changed; retry confirmation')
    await audit('login', account.id, entry.value.name)
    return completedPage(reply, entry.value)
  })
  app.post('/auth/cancel', async (req, reply) => {
    const key = `login-code:${identityHash(req.body?.device_code)}`, entry = await store.get(key)
    if (!entry) return { cancelled: true }
    if (!nativeLoginProof(entry, req.body)) return reply.code(400).send({ error: 'invalid_grant' })
    if (!await store.comparePut(key, entry, { ...entry, denied: true })) return reply.code(409).send({ error: 'login_changed' })
    return { cancelled: true }
  })
  app.post('/auth/token', async (req, reply) => {
    const key = `login-code:${identityHash(req.body?.device_code)}`, entry = await store.get(key)
    if (!entry || entry.expires <= Date.now()) { await store.delete(key); return reply.code(400).send({ error: 'expired_token' }) }
    if (!nativeLoginProof(entry, req.body)) return reply.code(400).send({ error: 'invalid_grant' })
    if (entry.denied) return reply.code(400).send({ error: entry.authorizationFailed ? 'authorization_failed' : 'access_denied' })
    if (req.body?.browser === true && entry.kind !== 'client') return reply.code(400).send({ error: 'client_grant_required' })
    if (Date.now() - entry.lastPoll < 4000) return reply.code(400).send({ error: 'slow_down' })
    if (!entry.confirmed) { await store.comparePut(key, entry, { ...entry, lastPoll: Date.now() }); return reply.code(400).send({ error: 'authorization_pending' }) }
    const grant = await store.take(key)
    if (!grant?.confirmed || grant.denied || !nativeLoginProof(grant, req.body)) return reply.code(400).send({ error: grant?.denied ? 'access_denied' : 'expired_token' })
    await store.delete(`login-user:${grant.userCode}`)
    if ((await store.get(`account:${grant.account.id}`))?.disabled) return reply.code(403).send({ error: 'membership_disabled' })
    // A popup and its opener share the HttpOnly session established by callback.
    // Completing that browser grant must not leave an unnecessary extra session.
    if (req.body?.browser === true && req.cookies[cookieName]) {
      try {
        const existing = await authenticate(req)
        if (existing.account.id === grant.account.id) return { authenticated: true, profile: existing.account, expires_in: Math.max(0, Math.floor((existing.expires - Date.now()) / 1000)) }
      } catch { /* A separate browser context needs its own session below. */ }
    }
    const credentials = await issue(grant.account, grant.kind)
    if (req.body?.browser === true) { cookies(reply, credentials); return { authenticated: true, profile: grant.account, expires_in: credentials.expires_in } }
    return credentials
  })
  app.post('/auth/refresh', async (req, reply) => {
    const browser = !req.body?.refresh_token
    const value = await store.take(`refresh:${identityHash(req.body?.refresh_token || req.cookies[refreshName])}`)
    if (!value || value.expires <= Date.now()) return reply.code(401).send({ error: 'login_required' })
    const { account, session } = await sessionFor(value.sessionId)
    const credentials = await issue(account, session.kind, session)
    if (browser) { cookies(reply, credentials); return { refreshed: true, expires_in: credentials.expires_in, profile: account } }
    return credentials
  })
  app.post('/auth/logout', async (req, reply) => {
    const identity = await authenticate(req, req.body?.kind === 'device' ? 'device' : 'client')
    if (req.body?.all === true) await revokeAccount(identity.account.id)
    else await revoke(identity.sessionId)
    reply.clearCookie(cookieName, { path: '/' }); reply.clearCookie(refreshName, { path: '/auth' })
    await audit('logout', identity.account.id, identity.sessionId)
    return { loggedOut: true }
  })
  app.get('/api/v1/profile', async req => (await authenticate(req)).account)
  app.post('/api/v1/admin/members/:id/disable', async (req, reply) => {
    const { account } = await authenticate(req)
    if (!account.admin) return reply.code(403).send({ error: 'Administrator required' })
    const member = await store.get(`account:${req.params.id}`)
    if (!member || member.organization !== account.organization) return reply.code(404).send({ error: 'Member not found' })
    await store.put(`account:${member.id}`, { ...member, disabled: true }); await revokeAccount(member.id)
    await audit('member.disabled', account.id, member.id)
    return { disabled: true }
  })
  return { authenticate, audit, revokeAccount, revoke }
}
