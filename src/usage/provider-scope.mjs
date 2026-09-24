import { createHmac } from 'node:crypto'

export function routeBudgetScope({ provider, model, protocol, baseUrl, credential = '' }) {
  const url = new URL(baseUrl)
  url.hash = ''
  const endpoint = url.href.replace(/\/$/, '')
  return createHmac('sha256', credential || url.search).update(JSON.stringify(['kkcode.approved-pricing.v1', provider, model, protocol, endpoint])).digest('hex')
}
