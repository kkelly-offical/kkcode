# kkcode 0.1.13 Mode Lane / Agent Contract

This document records the **shipped public contract** for the 0.1.13 slice.

It is release-facing: it describes what users can rely on now, including the boundaries that still remain out of scope.

## 1. Scope of the 0.1.13 slice

The committed 0.1.13 slice tightens four public areas:

1. **assistant / plan / agent / longagent public lane contract**
2. **CLI routing transparency**
3. **assistant-as-default bounded personal transaction language**
4. **explicit LongAgent heavyweight boundary**

Hard boundaries for this slice:

- CLI-first only
- keep LongAgent as the heavyweight structured multi-file lane
- no IDE-first workflow
- no GUI / desktop automation promise
- no marketplace / remote bridge / platform rewrite

## 2. Public lane contract

- **`assistant`** → default CLI personal assistant lane for bounded terminal-native work, explanation, analysis, and repo understanding
- **`plan`** → specification / implementation planning only; it does not execute file mutations
- **`agent` / `code` / `coding`** → dedicated coding lane for inspect / patch / verify work
- **`longagent`** → heavyweight staged delivery lane for multi-file or system-level work

`assistant` is the default general execution lane for bounded terminal-native personal transactions. `agent` remains the dedicated coding lane.

`longagent` remains explicitly heavyweight; it is not a generic sidecar task runner.

## 3. Routing contract

Routing remains explainable in the UI and CLI output.

Public expectations:

- short question / explanation request → prefer `assistant`
- short planning / design request without execution scope → `plan`
- bounded terminal personal work → prefer `assistant`
- explicit coding mutation / debugging / test repair → prefer `agent` / `code` / `coding`
- complex multi-file or system-level work with heavy evidence → suggest or use `longagent`
- `assistant -> agent` and `assistant|agent -> longagent` remain explicit upgrade paths, not random lateral switches

This remains a heuristic/rule-driven router, not a learned policy model.

## 4. Interruption / continuation contract

- `Esc` interrupts the current turn
- interrupted bounded local work may continue as the same local transaction
- `plan` remains explicit and mutation-free
- `longagent` keeps its staged continuation / replanning behavior

## 5. CLI general assistant boundary

kkcode remains a **CLI general assistant** with these safe lanes:

- coding and patching
- local filesystem / config / log inspection
- shell execution
- repo / release assistance
- web lookup / fetch
- bounded delegated sidecar work

This still means:

- **no GUI/desktop automation promise**
- **no IDE integration promise**
- **no remote platform expansion in this slice**

The authoritative capability matrix is:

- `docs/cli-general-assistant-capability-matrix.md`

## 6. Release-ready checklist

Treat 0.1.13 as documented correctly only when all of the following stay true:

- the four execution lanes stay explicit in docs and CLI help
- `assistant` remains the default bounded personal transaction lane
- `plan` remains explicit and mutation-free
- `longagent` stays heavyweight and staged
- route reasons remain visible in the TUI / CLI
- docs keep the CLI-first, non-GUI boundary explicit
