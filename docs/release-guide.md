# KKCODE Release Guide

## Scope

This release focuses on:

- provider onboarding parity with mobile/chat learnings
- stronger OAuth and provider diagnostics
- better longagent recovery UX
- stronger background worker reconciliation on newer Node runtimes
- TUI/REPL upgrades for recovery, sessions, checkpoints, and task visibility

## Pre-Release Checklist

Run the full test suite:

```bash
node --test
```

Recommended manual smoke checks:

```bash
OPENAI_API_KEY=... kkcode init --yes --onboard-auth
OPENAI_API_KEY=... kkcode auth verify openai
kkcode auth onboard openai --no-login
kkcode longagent status --session <id>
kkcode longagent checkpoints --session <id>
kkcode background center
```

Check the following user-facing flows:

- `kkcode init --providers`
- `kkcode auth providers`
- `kkcode auth probe <provider>`
- `kkcode auth onboard <provider>`
- REPL/TUI shortcuts:
  - `Ctrl+R` recovery picker
  - `Ctrl+S` session picker
  - `Ctrl+K` checkpoint picker
  - `Ctrl+O` model picker
  - `Ctrl+G` permission policy picker

## Release Notes Summary

Suggested highlights:

- Added continuous provider onboarding via `kkcode auth onboard <provider>`
- Added `kkcode auth verify <provider>` for fast runtime verification
- Added `init --onboard-auth`
- Improved longagent recovery with recommended actions and readable checkpoints output
- Improved TUI pickers with filterable session and checkpoint search
- Improved background worker boot/heartbeat reconciliation

## Known Issues

### Node 25 worker lifecycle edge case

`kkcode` now recovers background worker state much more aggressively on Node 25, including boot confirmation and stale worker reconciliation. Main features are usable, but Node 25 is still not the preferred baseline for longagent/background-worker heavy workflows.

Recommended guidance:

- prefer Node 22.x for production/stable usage
- Node 25.x is acceptable for evaluation, but not the default recommendation yet

Suggested wording for release notes:

> Node 25.x has a known worker lifecycle edge case in abrupt-exit scenarios. `kkcode` now mitigates this better, but Node 22.x remains the stable baseline for longagent and background workers.

### Browser OAuth metadata gaps

Some catalog providers declare OAuth support but still require provider-specific authorize/token metadata overrides before browser login can be fully automatic.

User guidance:

- use `kkcode auth onboard <provider>` first
- if onboarding reports a login metadata gap, follow the emitted `next:` instruction

## GitHub Release Prep

Before pushing:

1. Confirm `node --test` is green.
2. Review `git diff` for accidental local config files or smoke-check artifacts.
3. Update release notes using the summary above.
4. Mention Node 22 as the recommended runtime baseline.
