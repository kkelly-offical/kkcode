# kkcode REPL Roadmap 0.1.27 → 0.1.36

This roadmap tracks the staged REPL refactor that compares kkcode’s CLI-first runtime against the reference seams around `claudenext-private/src/screens/REPL.tsx`.

## Goals

- Keep kkcode CLI-first / LongAgent-first
- Reduce `src/repl.mjs` over time
- Ship each phase as a small `0.1.*` GitHub release
- Prefer extraction + verification over wholesale rewrites

## Version map

| Version | Focus |
| --- | --- |
| 0.1.27 | `repl-core-shell` |
| 0.1.28 | `repl-input-engine` |
| 0.1.29 | `repl-command-surface` |
| 0.1.30 | `repl-turn-lifecycle` |
| 0.1.31 | `repl-state-facade` |
| 0.1.32 | `repl-dialog-kernel` |
| 0.1.33 | `repl-transcript-panels` |
| 0.1.34 | `repl-capability-fusion` + operator-oriented status surface |
| 0.1.35 | `repl-quality-rails` |
| 0.1.36 | stabilization / workflow hardening |

## Guardrails

1. `src/repl.mjs` should trend downward in ownership.
2. Each release must carry tests.
3. Do not re-inline extracted seams.
4. Runtime facades should stay light; no heavy state framework.
5. Final release should stabilize delivery and release ergonomics.
