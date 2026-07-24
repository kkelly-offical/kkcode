# KK Code 0.4.0 Mode & Approval Contract

This document records the **shipped public contract** for the 0.4.0 mode
system. It replaces the user-facing vocabulary of the 0.1.13 lane contract,
which remains archived for historical reference.

## 1. Five public modes

0.4.0 collapses the mode vocabulary into a single flat cycle. `Shift+Tab`
walks it; `/mode` opens a picker; `/mode <id>` switches directly.

| Mode | Id | Lane | Approval | Guarantee |
| --- | --- | --- | --- | --- |
| ⏸ Plan | `plan` | `plan` | `readonly` | produces a spec/plan only; never mutates files |
| ● Agent | `agent` | `assistant` | `manual` | default lane; edits are confirmed before they land |
| ▶ Agent · Auto | `agent-auto` | `assistant` | `accept-edits` | edits and subagents run unattended; risky shell still asks |
| ⚡ Ultra | `ultra` | `longagent` | `accept-edits` | staged multi-file delivery with gates, checkpoints and resume |
| ☠ YOLO | `yolo` | `assistant` | `yolo` | every approval prompt is skipped |

Each mode is a **(lane, approval) pair**. The lane decides *how work is
orchestrated*; the approval level decides *what may run without asking*.
The three `assistant`-lane modes differ only in approval.

**Lane identifiers are unchanged from 0.3.x.** `assistant`, `plan` and
`longagent` remain the internal execution vocabulary, so sessions, hooks,
`permission.rules[].modes[]` and the system prompt contract keep working.

## 2. Four approval levels

| Level | read / search / network | safe shell | risky shell | edit | subagent |
| --- | --- | --- | --- | --- | --- |
| `readonly` | allow | deny | deny | deny | deny |
| `manual` (default) | allow | allow | ask | ask | ask |
| `accept-edits` | allow | allow | ask | allow | allow |
| `yolo` | allow | allow | allow | allow | allow |

Safe shell is a fixed allowlist of read-only commands (`git status`, `ls`,
`rg`, …). Sensitive paths — `.env`, `.kkcode/**`, `.github/workflows/**`,
`AGENTS.md` and friends — escalate an `allow` back to `ask` at every level
except `yolo`.

`permission.level` is the only approval switch. Switching mode rewrites it,
and `/permission cycle` walks the four levels without changing mode.

## 3. Persistent approvals

The permission prompt offers four choices:

```
1. Allow Once      2. Allow Session      3. Always Allow      4. Deny
```

**Always Allow** writes a normal rule into `permission.rules[]` in the
**user** config (`~/.kkcode/config.yaml`), carrying a `workspace` field that
scopes it to the current project and `source: learned` so it can be listed
and revoked as a group:

```yaml
permission:
  rules:
    - tool: bash
      action: allow
      command_prefix: "npm test"
      workspace: /abs/path/to/project
      source: learned
```

Grants deliberately do not go to the project config: a user repository's
`.gitignore` may not cover `.kkcode/`, which would commit their approvals.
Rules without a `workspace` stay global, preserving 0.3.x semantics.

Manage them with `/permission list` and `/permission forget <n|all>`.

## 4. Plan handoff

`/plan` stays read-only and mutation-free. When the model calls `exit_plan`,
the saved plan is presented with four choices: **Build**, **Ultra Build**,
**Compact + Build** and **Compact + Ultra Build**.

Choosing one **switches mode for real** and immediately runs the build turn
against the saved plan file. In 0.3.x this only pushed a sentence back to
the model asking the user to run `/longagent` themselves.

## 5. Model roles

```yaml
models:
  main: kimi-k3          # falls back to provider.<default>.default_model
  fast: kimi-k3-turbo    # optional; ghost text and titles need it
  subagent: kimi-k3      # optional; defaults to main
```

`fast` deliberately does not fall back to `main`. An unconfigured fast model
disables the features that depend on it rather than billing the expensive
model for completions. `agent.subagents.<name>.model` still overrides by
subagent name.

## 6. Compatibility

Every 0.3.x spelling keeps working and maps automatically, printing a
one-time deprecation notice. Removal is planned for 0.5.0.

| 0.3.x | 0.4.0 |
| --- | --- |
| `/longagent` | `/ultra` |
| `assistant` / `agent` / `code` / `coding` modes | `agent` |
| `permission.level: review` or `auto` | `manual` |
| `permission.level: edit` or `full-auto` | `accept-edits` |
| `permission.mode`, `permission.default_policy` | `permission.level` |
| `agent.longagent.four_stage.*` | removed with the 4stage implementation |
| `hybrid.separate_models`, `adaptive_models`, `degradation.fallback_model` | `models.*` |

**`permission.level: auto` maps to `manual`, not to `accept-edits`.** In
0.3.x `auto` meant "edits still ask", so the new level was named
`accept-edits` rather than reusing `auto` — a same-name-different-meaning
mapping would have silently widened existing configs on upgrade.

## 7. Boundaries

Unchanged from 0.3.x:

- CLI-first only
- Ultra stays the heavyweight staged lane, not a generic task runner
- no GUI / desktop automation promise
- no IDE-first workflow
- no marketplace / remote bridge

The authoritative capability matrix remains
`docs/cli-general-assistant-capability-matrix.md`.
