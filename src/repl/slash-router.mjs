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

export function buildSlashCatalog({ builtinSlash = [], customCommands = [], skills = [] } = {}) {
  const custom = customCommands.map((cmd) => ({
    name: cmd.name,
    desc: `custom (${cmd.scope || "project"})`
  }))
  const customNames = new Set(custom.map((item) => item.name))
  const skillEntries = skills
    .filter((skill) => !customNames.has(skill.name))
    .map((skill) => ({ name: skill.name, desc: `skill (${skill.type})` }))
  return [...builtinSlash, ...custom, ...skillEntries]
}

export function slashQuery(inputLine) {
  if (!String(inputLine || "").startsWith("/")) return null
  const raw = String(inputLine).slice(1)
  const firstSpace = raw.indexOf(" ")
  return (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim()
}

export function slashSuggestions(inputLine, options = {}) {
  const token = slashQuery(inputLine)
  if (token === null) return []
  const all = buildSlashCatalog(options)
  const q = token.toLowerCase()
  return all
    .map((item) => {
      const name = item.name.toLowerCase()
      let rank = 99
      if (!q) rank = 0
      else if (name === q) rank = 0
      else if (name.startsWith(q)) rank = 1
      else if (name.includes(q)) rank = 2
      return { ...item, rank }
    })
    .filter((item) => item.rank < 99)
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name))
}

export function applySuggestionToInput(current, suggestionName) {
  const raw = String(current || "")
  if (!raw.startsWith("/")) return raw
  const body = raw.slice(1)
  const firstSpace = body.indexOf(" ")
  if (firstSpace < 0) return `/${suggestionName} `
  return `/${suggestionName}${body.slice(firstSpace)}`
}

export function normalizeSlashAlias(line, aliases = DEFAULT_SLASH_ALIASES) {
  return aliases[String(line || "")] || line
}
