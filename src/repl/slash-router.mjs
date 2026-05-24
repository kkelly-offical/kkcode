export const DEFAULT_SLASH_ALIASES = {
  "/h": "/help",
  "/?": "/help",
  "/n": "/new",
  "/s": "/session",
  "/k": "/keys",
  "/r": "/resume",
  "/m": "/mode",
  "/p": "/provider",
  "/q": "/exit"
}

export function buildSlashCatalog({ builtinSlash = [], customCommands = [] } = {}) {
  const custom = customCommands.map((cmd) => ({
    name: cmd.name,
    desc: `custom (${cmd.scope || "project"})`
  }))
  return [...builtinSlash, ...custom]
}

export function buildSkillCatalog({ customCommands = [], skills = [] } = {}) {
  const customNames = new Set(customCommands.map((item) => item.name))
  return skills
    .filter((skill) => !customNames.has(skill.name))
    .map((skill) => ({ name: skill.name, desc: `skill (${skill.type})` }))
}

export function commandQuery(inputLine) {
  const value = String(inputLine || "")
  const prefix = value.startsWith("$") ? "$" : value.startsWith("/") ? "/" : null
  if (!prefix) return null
  const raw = value.slice(1)
  const firstSpace = raw.indexOf(" ")
  return { prefix, token: (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim() }
}

export function slashQuery(inputLine) {
  const query = commandQuery(inputLine)
  return query?.prefix === "/" ? query.token : null
}

export function skillQuery(inputLine) {
  const query = commandQuery(inputLine)
  return query?.prefix === "$" ? query.token : null
}

export function slashSuggestions(inputLine, options = {}) {
  const query = commandQuery(inputLine)
  if (query === null) return []
  const all = query.prefix === "$" ? buildSkillCatalog(options) : buildSlashCatalog(options)
  const q = query.token.toLowerCase()
  return all
    .map((item) => {
      const name = item.name.toLowerCase()
      let rank = 99
      if (!q) rank = 0
      else if (name === q) rank = 0
      else if (name.startsWith(q)) rank = 1
      else if (name.includes(q)) rank = 2
      return { ...item, prefix: query.prefix, rank }
    })
    .filter((item) => item.rank < 99)
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name))
}

export function applySuggestionToInput(current, suggestionName) {
  const raw = String(current || "")
  const prefix = raw.startsWith("$") ? "$" : raw.startsWith("/") ? "/" : null
  if (!prefix) return raw
  const body = raw.slice(1)
  const firstSpace = body.indexOf(" ")
  if (firstSpace < 0) return `${prefix}${suggestionName} `
  return `${prefix}${suggestionName}${body.slice(firstSpace)}`
}

export function normalizeSlashAlias(line, aliases = DEFAULT_SLASH_ALIASES) {
  return aliases[String(line || "")] || line
}
