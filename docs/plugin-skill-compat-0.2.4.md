# kkcode 0.2.4 Plugin and Skill Compatibility

This document defines the 0.2.4 production baseline for local plugin and Agent Skill compatibility.

## Compatibility boundary

0.2.4 supports local discovery, parsing, loading, and diagnostics for kkcode, Claude Code, Codex, and OpenCode extension layouts. It does not implement remote marketplace install/update flows, npm/Bun dependency installation, external app account connections, Claude LSP/monitor execution, or OpenCode TypeScript plugin execution.

## Supported skill roots

kkcode loads directory-format `SKILL.md` skills from these locations:

| Ecosystem | Project path | User path |
| --- | --- | --- |
| kkcode | `.kkcode/skills/<name>/SKILL.md` | `$KKCODE_HOME/skills/<name>/SKILL.md` |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |
| Codex / Agent Skills | `.agents/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |
| OpenCode | `.opencode/skills/<name>/SKILL.md` | `~/.config/opencode/skills/<name>/SKILL.md` |

Project paths are discovered from the current working directory up to the Git root. Duplicate physical directories are deduplicated after symlink resolution.

## Supported plugin packages

kkcode recognizes local plugin manifests from:

- `.kkcode-plugin/plugin.json`
- `.kkcode/plugins/<name>/plugin.json`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`

Manifests are normalized into kkcode components: skills, agents, hooks, and MCP servers. Plugin skills are namespaced as `$plugin-name:skill-name`. If the non-namespaced alias is free, kkcode also exposes it as a convenience alias; collisions are diagnosed instead of silently shadowing.

OpenCode plugin files under `.opencode/plugins/` and `~/.config/opencode/plugins/` are discovered for diagnostics but are not executed in 0.2.4. JavaScript execution can be added later behind an explicit permission model; TypeScript plugins require precompilation.

## Field support

Skill frontmatter:

| Field | Support |
| --- | --- |
| `name`, `description` | enforced |
| `model`, `allowed-tools`, `user-invocable`, `disable-model-invocation`, `context`, `context-fork` | enforced when mapped to existing kkcode behavior |
| `when_to_use`, `argument-hint`, `arguments`, `agent`, `effort`, `paths`, `license`, `compatibility`, `metadata` | preserved and surfaced as metadata |
| skill-level hook registration or unrestricted shell execution | rejected or diagnosed |

Plugin manifest fields:

| Field | Support |
| --- | --- |
| `name`, `version`, `description`, `displayName`, `author`, `homepage`, `repository`, `license`, `keywords` | parsed metadata |
| `skills`, `agents`, `hooks`, `mcpServers`, `mcp_servers`, `components` | normalized components |
| Codex apps, Claude LSP, Claude monitors, OpenCode npm dependencies | diagnosed as unsupported in 0.2.4 |

## Diagnostics and commands

- `kkcode doctor --json` includes a `compat` section with discovered ecosystems, plugin counts, skill counts, unsupported component counts, and diagnostics.
- `kkcode skill list --json` reports canonical names, aliases, source ecosystem, plugin name, and skill root.
- `kkcode plugin list --json` reports local plugin manifests, enabled state, component counts, unsupported components, and diagnostics.

Set `compat.diagnostics.strict: true` to make doctor fail when compatibility diagnostics are present.

## Security rules

- Manifest paths must resolve inside the plugin root.
- Plugin MCP servers are plugin-scoped before merging with user configuration.
- Plugin hooks from non-kkcode ecosystems are not executed unless `compat.plugins.execute_external_hooks: true`.
- Unsupported components are reported explicitly; they are not silently loaded.
