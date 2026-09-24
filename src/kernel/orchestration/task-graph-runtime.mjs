const hosts = new WeakSet()
// Host imports this constructor helper; it is not a model tool or RPC action.
export function brandTaskGraphHost(host) { hosts.add(host); return host }
export const isTaskGraphHost = host => Boolean(host && hosts.has(host))
