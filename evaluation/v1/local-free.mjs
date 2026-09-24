/** Evaluation-side allocation only. This is not an inference capability: the
 * runtime still requires its own host-branded local-free authorization and
 * persists every reservation in the durable request ledger. */
export function allocateLocalFreeLimits(input, count) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'requestLimit,tokenLimit'
    || !Number.isSafeInteger(count) || count < 1
    || ![input.requestLimit, input.tokenLimit].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Local-free evaluation requires explicit positive finite request and token limits')
  }
  const perTask = { requestLimit: Math.floor(input.requestLimit / count), tokenLimit: Math.floor(input.tokenLimit / count) }
  if (!perTask.requestLimit || !perTask.tokenLimit) throw new Error('Local-free suite limits cannot provide a bounded allocation for every selected task')
  return { total: { requestLimit: input.requestLimit, tokenLimit: input.tokenLimit }, perTask }
}

export function assertLocalFreeProfile(profile) {
  const url = new URL(profile.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error('Local-free evaluation is restricted to an explicit literal loopback provider endpoint')
  if (!profile.pricing || Object.keys(profile.pricing).sort().join(',') !== 'cache_read,cache_write,input,output'
    || Object.values(profile.pricing).some(rate => rate !== 0)) throw new Error('Local-free evaluation requires all four explicitly declared zero USD prices')
}
