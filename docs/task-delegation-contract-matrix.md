# Task Delegation Contract Matrix (0.1.11 slice)

Date: 2026-04-11
Status: shipped behavior for the 0.1.11 compatibility tranche

This document describes the lightweight delegation contract that kkcode now exposes for the `task` tool without weakening LongAgent.

## Scope boundary

- **LongAgent** remains the preferred lane for structured multi-file delivery, file ownership, retries, and stage gates.
- **`task` delegation** remains the lighter lane for bounded sidecar work, focused specialist help, and background execution.
- This slice is **CLI-first only**. It does not add GUI automation, marketplace installs, or remote bridge behavior.

## Support matrix

| Capability | 0.1.11 support | Notes |
| --- | --- | --- |
| `prompt` | Enforced | Full self-authored delegation brief still works. |
| Structured brief fields (`objective`, `why`, `write_scope`, `starting_points`, `constraints`, `deliverable`) | Enforced | kkcode synthesizes a directive prompt when `prompt` is omitted. |
| `execution_mode="fresh_agent"` | Enforced | Default mode for isolated delegated work. |
| `execution_mode="fork_context"` | Enforced | Forks the parent session transcript before delegated execution. |
| `session_id` continuation | Enforced | Reuses an existing delegated sub-session. |
| `run_in_background` | Enforced | Returns deterministic background task metadata for status/result retrieval. |
| Stay-local vs delegate guidance | Enforced in prompt/tool contract | The generated brief reminds the child not to replace cheaper direct work. |
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

The synthesized delegation brief includes three rules:

- stay local if the next step is cheaper to perform directly
- do not fabricate completion or present unfinished work as done
- do not peek at unfinished sibling work and turn guesses into facts

These rules intentionally tighten the lightweight delegated lane without expanding it into a LongAgent replacement.

## Release notes guidance

If release notes mention this slice, describe it as:

- **better delegation briefing discipline**
- **clearer fresh-agent vs fork-context behavior**
- **deterministic background delegation tracking**
- **no new worktree/remote delegation platform yet**
