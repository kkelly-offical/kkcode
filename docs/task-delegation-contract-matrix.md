# Task Delegation Contract Matrix (0.1.14 slice)

Date: 2026-04-11
Status: shipped behavior for the 0.1.14 delegation-hardening tranche

This document describes the lightweight delegation contract that kkcode now exposes for the `task` tool without weakening LongAgent.

## Scope boundary

- **LongAgent** remains the preferred lane for structured multi-file delivery, file ownership, retries, and stage gates.
- **`task` delegation** remains the lighter lane for bounded sidecar work, focused specialist help, and background execution.
- This slice is **CLI-first only**. It does not add GUI automation, marketplace installs, or remote bridge behavior.

## Support matrix

| Capability | 0.1.14 support | Notes |
| --- | --- | --- |
| `prompt` | Enforced | Full self-authored delegation brief still works. |
| Structured brief fields (`objective`, `why`, `write_scope`, `starting_points`, `constraints`, `deliverable`) | Enforced | kkcode synthesizes a directive prompt when `prompt` is omitted, and now requires `write_scope` plus `deliverable`. |
| `execution_mode="fresh_agent"` | Enforced | Default mode for isolated delegated work. |
| `execution_mode="fork_context"` | Enforced | Reserved for read-only sidecar work that benefits from inheriting the parent transcript. |
| `session_id` continuation | Enforced | Reuses an existing delegated sub-session, but now requires a short continuation prompt and rejects structured brief fields. |
| `run_in_background` | Enforced | Returns deterministic background task metadata for status/result retrieval and rejects interactive questions. |
| Stay-local vs delegate guidance | Enforced in prompt/tool contract | The generated brief reminds the child not to replace cheaper direct work. |
| Never-delegate-understanding guidance | Enforced in prompt/tool contract | Parent agent keeps synthesis and judgment responsibilities. |
| No-peek / no-fabrication guidance | Enforced in prompt/tool contract | The generated brief and tool docs prohibit guessing unfinished work. |
| Worktree isolation | Not supported in this slice | Still future work; do not imply it exists. |
| Remote/marketplace/plugin runtime delegation | Out of scope | Compatibility work remains local and CLI-first. |

## Structured brief contract

When `prompt` is omitted for a new delegated run, kkcode builds a directive brief using these sections:

1. `Objective`
2. `Why`
3. `Write scope`
4. `Starting points`
5. `Constraints`
6. `Planned files` (if supplied)
7. `Deliverable`
8. `Execution contract`

This keeps delegated prompts self-contained and more portable while avoiding hidden parent-context dependencies.

## Execution contract reminders

The synthesized delegation brief includes five rules:

- stay local if the next step is cheaper to perform directly
- never delegate understanding of the problem itself
- keep fresh agents self-contained and forked-context work directive-style
- do not fabricate completion or present unfinished work as done
- do not peek at unfinished sibling work and turn guesses into facts
- keep background delegates non-interactive

These rules intentionally tighten the lightweight delegated lane without expanding it into a LongAgent replacement.

## Release notes guidance

If release notes mention this slice, describe it as:

- **harder delegation briefing discipline**
- **clearer fresh-agent vs fork-context vs continued-session behavior**
- **deterministic background delegation tracking**
- **no new worktree/remote delegation platform yet**
