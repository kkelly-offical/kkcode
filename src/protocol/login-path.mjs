/** The KK Code device grant always uses this local route. Never navigate to
 * an arbitrary verification_uri_complete supplied in an API response. */
export function deviceLoginPath(code) {
  if (typeof code !== 'string' || code.length !== 8 || !/^[0-9]{8}$/.test(code)) throw new Error('Invalid gateway login code')
  return `/login?code=${encodeURIComponent(code)}`
}
