// Adapter provenance remains in-process and non-serializable. A zero inserted
// by a normalizer is not proof that the upstream actually reported a counter.
const complete = new WeakSet()
const identities = new WeakMap()
const counter = value => Number.isSafeInteger(value) && value >= 0
export function markUsageEvidence(usage, required, optional = [], valid = true) {
  if (valid && required.every(counter) && optional.every(value => value == null || counter(value))) complete.add(usage)
  return usage
}
export const hasCompleteUsageEvidence = usage => Boolean(usage && complete.has(usage))
export function markUsageIdentity(usage, identity) { identities.set(usage, Object.freeze({ model: identity.model, tier: identity.tier ?? null })); return usage }
export const usageIdentity = usage => usage && identities.get(usage)
