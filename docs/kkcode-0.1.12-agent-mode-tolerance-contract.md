# kkcode 0.1.12 Agent Mode Tolerance / CLI General Assistant Contract

This document records the **shipped public contract** for the 0.1.12 slice approved in:

- `.omx/plans/prd-kkcode-0.1.12-agent-mode-tolerance.md`
- `.omx/plans/test-spec-kkcode-0.1.12-agent-mode-tolerance.md`
- `docs/cli-general-assistant-capability-matrix.md`

It is release-facing: it describes what users can rely on now, including the boundaries that still remain out of scope.

## 1. Scope of the 0.1.12 slice

The committed 0.1.12 slice covers four areas:

1. **Transaction-aware routing 2.0**
2. **Agent continuation after interrupt**
3. **Prompt/runtime alignment for agent-as-default**
4. **Observability for over-escalation and continuation**

Hard boundaries for this slice:

- CLI-first only
- keep LongAgent as the heavyweight structured multi-file lane
- no IDE-first workflow
- no GUI / desktop automation promise
- no marketplace / remote bridge / platform rewrite

## 2. Routing contract

`agent` is now the default general execution lane for bounded local transactions.

### Public routing rules

- **Short question / explanation request** → prefer `ask`
- **Bounded inspect / patch / verify work** → prefer `agent`
- **Interrupted local task with follow-up** → prefer continuing the same `agent` transaction
- **Complex multi-file / system-level work with heavy evidence** → suggest or use `longagent`
- **Short planning/design request without execution scope** → `plan`

### Transparency contract

Routing remains explainable in the UI and CLI output. Route decisions expose:

- reason tags such as `local_transaction_task` and `multi_file_or_system_task`
- task topology such as `bounded_local_transaction` or `heavy_multi_file_delivery`
- evidence categories used by observability and release review

This remains a heuristic/rule-driven router, not a learned policy model.

## 3. Interruption / continuation contract

0.1.12 extends interruption handling beyond the 0.1.11 baseline.

### Foreground `agent` behavior

- `Esc` interrupts the current turn
- busy `Ctrl+C` behaves the same way
- the session stays alive
- the next follow-up input is treated as a continuation of the current bounded transaction when the scope still fits `agent`

### LongAgent behavior

- LongAgent still keeps its heavyweight continuation flow
- interruption plus follow-up input may restart from planning with merged requirements
- this slice does not flatten LongAgent into a generic delegated task runner

## 4. Observability contract

0.1.12 adds minimal machine-readable observability for the routing tolerance work.

Release review can inspect counters for:

- stayed-local success decisions
- deferred `longagent` suggestions
- over-escalated `longagent` requests
- interrupted-and-resumed agent transactions

These counters live in the observability report and event stream; they do not imply a remote control plane or IDE telemetry product.

## 5. CLI general assistant boundary

kkcode remains a **CLI general assistant** with these safe lanes:

- coding and patching
- local filesystem / config / log inspection
- shell execution
- repo / release assistance
- web lookup / fetch
- bounded delegated sidecar work

The authoritative release-facing matrix is:

- `docs/cli-general-assistant-capability-matrix.md`

This still means **no GUI/desktop automation promise**, no IDE integration promise, and no remote platform expansion in this slice.

## 6. Release-ready checklist

Treat 0.1.12 as documented correctly only when all of the following stay true:

- routing remains explainable in the TUI
- bounded local tasks stay in `agent` unless heavy evidence appears
- interrupted `agent` turns can continue as the same transaction
- prompt/runtime copy says `agent` is the default bounded transaction lane
- observability shows stayed-local / over-escalation / continuation counters
- docs keep the CLI general assistant boundary explicit and non-GUI
