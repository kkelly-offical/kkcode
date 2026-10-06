'use strict'

function gatewayOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入网关地址')
  let url
  try { url = new URL(value.trim()) } catch { throw new Error('网关地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hash || url.search || !['', '/'].includes(url.pathname)) throw new Error('请输入不含账号、路径或参数的 HTTPS 网关地址')
  return url.origin
}

function externalUrl(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function trustedFrame(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false
  try { return new URL(event.senderFrame.url).origin === origin } catch { return false }
}

function uiPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  const choices = { 'kkcode.web.theme': ['dark', 'light', 'auto'], 'kkcode.studio.palette': ['mint', 'amber', 'iris'], 'kkcode.studio.motion': ['on', 'off'], 'kkcode.studio.compact': ['on', 'off'] }
  for (const [key, values] of Object.entries(choices)) if (values.includes(value[key])) result[key] = value[key]
  try {
    const reading = JSON.parse(value['kkcode.web.reading'])
    if ([90, 100, 110, 125, 150].includes(reading.scale) && ['focused', 'wide', 'full'].includes(reading.width)) result['kkcode.web.reading'] = JSON.stringify({ scale: reading.scale, width: reading.width })
  } catch { /* Invalid or absent display preferences use the client defaults. */ }
  return result
}

function bundledGatewayAsset(request, origins, assets) {
  if (request.method !== 'GET') return null
  try {
    const url = new URL(request.url)
    return origins.has(url.origin) && !url.username && !url.password && assets.has(url.pathname) ? url.pathname : null
  } catch { return null }
}

module.exports = { gatewayOrigin, externalUrl, trustedFrame, uiPreferences, bundledGatewayAsset }
