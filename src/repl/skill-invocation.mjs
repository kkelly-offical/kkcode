/** One user-invocation boundary: flags, expansion result and restrictive tool context. */
export async function expandUserSkill(registry, name, args, { cwd, state, config }) {
  const skill = registry.isReady() ? registry.get(name) : null
  if (!skill) throw new Error(`unknown skill: $${name}`)
  if (skill.userInvocable === false) throw new Error(`skill $${name} is not user-invocable`)
  const expanded = await registry.execute(name, args, { cwd, mode: state.mode, model: state.model, provider: state.providerType, config })
  const prompt = typeof expanded === 'object' && expanded?.contextFork ? expanded.prompt || '' : expanded
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`skill $${name} returned no output`)
  return { prompt, model: expanded?.contextFork ? expanded.model : null, allowedTools: skill.allowedTools || null }
}
