# Project working memory

## Current Status (1.0.5 Preview)

- **Version**: `1.0.5-preview.0`
- **State**: Development in progress on branch `acceptance/1.0.5-trusted-runtime-20260924`. Not published to main/npm/production.
- **CI/Security**: 
  - Unified CI `35995852376`: **SUCCESS** (all 12 jobs: Linux, Windows, macOS, strict-runtime, isolated-toolchains, 6 branded browsers).
  - CodeQL `35995969121`: **SUCCESS** (all 3 languages). 17 historical alerts; no new high-severity issues.
  - Browser Gates: Chrome/Edge slots passed in latest CI. Historical failures are archived; current state is green.
  - Android Package: `9637f55` (SHA `0a356011...70008`). Clean install, all 16 exports verified. Not uploaded.
- **Model Evaluation**: 
  - Status: **Pending**. 
  - Last known v3 run: 108 pass / 11 fail / 1 error (90%). Release gate not passed.
  - Current action: Frozen v4 snapshot prepared (`8ce71a4`). No live model calls authorized without new user grant. Old deadline expired.
  - Distinction: "Engineering CI passed" does NOT equal "Real Model Quality Passed".
- **Publications**: None pending. No new binaries, tags, or production deployments generated in this cycle.

## Historical Archive & Constraints

- **Stable Release**: `1.0.4` (Tag `v1.0.4`, Commit `8ed6919`). Published. Do not move tag.
  - Receipts: `docs/stable-1.0.4-worklog.md`.
- **Previous Preview**: `1.0.4-preview.0` (Commit `a9b88a7`). Published.
- **Legacy Issues**: 
  - Historical CI failures (e.g., "brand CI failed", "not merged to main") in older work-package tables are obsolete. The current CI pipeline is passing. Do not treat these as current blockers.
  - `PR #6` status: Under review. Not merged. Do not assume completion based on this documentation update.
- **Constraints**:
  - Do not upgrade production gateway or demo VM automatically.
  - Do not reuse expired model test windows or paid call authorizations.
  - Preserve all historical receipts, failure logs, and commit links in `docs/` and `test-results/`. Do not delete old records.

## Handoff & Valid Rules

- **Documentation**: All local links in README, Roadmap, and Nav must resolve. Ensure "Current Status" sections reflect the `1.0.5` preview state above, while older versions remain in their respective historical docs.
- **Code Changes**: Submit via PR with mandatory review. No direct merges to main for significant changes.
- **Verification**: 
  - "Interface has code" ≠ "Engineering CI passed" ≠ "Real Model passed" ≠ "Production Deployed". State which level applies in all reports.
  - Real model tests require fresh, finite authorization.
- **Git Identity**: Author email `24042203053@ecupl.edu.cn`.

## Links

- [Implementation Plan](docs/plan-1.0.5.md)
- [Implementation Log](docs/implementation-1.0.5.md)
- [CodeQL Triage](docs/codeql-triage-1.0.5.md)