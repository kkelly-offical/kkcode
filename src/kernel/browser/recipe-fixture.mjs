import { createHash, randomUUID } from 'node:crypto'
import { createBrowserController } from './controller.mjs'
import { BrowserNetwork } from './network.mjs'

/** Host-selected synthetic fixture, never fetched from a live site. The browser
 * has a fresh profile and deny proxy; every HTTP request is fulfilled from this
 * fixed in-memory document or rejected, so page scripts cannot egress. */
export function createBrowserRecipeFixtureRunner({ html, parameters = {}, assertions, browserConfig = {} }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 512 * 1024 || !Array.isArray(assertions) || !assertions.length || assertions.length > 64 || assertions.some(value => typeof value !== 'string' || !value || value.length > 1000)) throw new Error('Fixture 需要最多 512 KiB HTML 和 1–64 个明确的最终 snapshot 文本断言')
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.values(parameters).some(value => typeof value !== 'string' || value.length > 4096)) throw new Error('Fixture 参数必须为有界字符串')
  const fixtureParameters = Object.freeze({ ...parameters }), checks = Object.freeze([...assertions])
  const fixtureHash = createHash('sha256').update(JSON.stringify({ html, parameters: fixtureParameters, assertions: checks })).digest('hex')
  return async ({ hash, candidate, signal }) => {
    const origin = new URL(candidate.origin).origin
    const network = new BrowserNetwork()
    network.target = async value => {
      const url = new URL(value)
      if (url.origin !== origin || url.username || url.password) throw new Error('Recipe fixture 禁止任何外部网络请求')
      return { url, address: '127.0.0.1', family: 4 }
    }
    network.fetch = async (value, options = {}) => {
      network.controller.signal.throwIfAborted()
      if (++network.requests > 100) throw new Error('Recipe fixture 请求超过 100 次安全上限')
      await network.target(value)
      if (!['GET', 'HEAD'].includes(options.method || 'GET')) throw new Error('Recipe fixture 禁止服务端副作用')
      const body = Buffer.from(options.method === 'HEAD' ? '' : html)
      network.bytes += body.length
      if (network.bytes > 16 * 1024 * 1024) throw new Error('Recipe fixture 内容超过 16 MiB 累计安全上限')
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body }
    }
    const browser = createBrowserController({ networkFactory: () => network })
    const ctx = { sessionId: `recipe-fixture-${randomUUID()}`, config: browserConfig, signal }
    try {
      await browser.execute({ action: 'open', url: `${origin}/` }, ctx)
      let executedSteps = 0
      for (const template of candidate.steps) {
        signal?.throwIfAborted()
        if (!['open', 'snapshot', 'click', 'fill', 'press'].includes(template.action)) throw new Error('Fixture 不支持该 recipe 动作')
        const action = { action: template.action }
        if (template.role) Object.assign(action, { role: template.role, name: template.name || fixtureParameters[template.nameParameter] })
        if (template.action === 'fill') action.value = fixtureParameters[template.valueParameter]
        if (template.action === 'press') action.key = template.key
        if (template.action === 'open') {
          const url = new URL(fixtureParameters[template.pathParameter], origin)
          if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw new Error('Fixture 导航必须是本站路径，不得包含凭据或查询')
          action.url = url.href
        }
        await browser.execute(action, ctx); executedSteps++
      }
      const final = await browser.execute({ action: 'snapshot' }, ctx)
      return { hash, fixtureHash, isolated: true, network: 'blocked', executedSteps, assertions: checks.map(value => String(final).includes(value)) }
    } finally { await browser.shutdown() }
  }
}
