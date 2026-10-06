'use strict'
function loginState(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) }
function loginReturn(value, pending, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 256 || !pending || now > pending.expires) return false
  try {
    const url = new URL(value)
    return url.protocol === 'cn.kkcode.desktop:' && url.host === 'auth' && url.pathname === '/complete' && !url.username && !url.password && !url.hash && [...url.searchParams.keys()].length === 1 && loginState(url.searchParams.get('state')) && url.searchParams.get('state') === pending.state
  } catch { return false }
}
module.exports = { loginState, loginReturn }
