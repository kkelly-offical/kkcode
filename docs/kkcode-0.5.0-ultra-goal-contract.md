# kkcode 0.5.0 — Ultra Goal Mode Contract

This document is the public contract for Ultra's goal mode introduced in 0.5.0.
It complements (does not replace) the 0.1.13 mode-lane contract and the 0.4.0
mode contract.

## The promise

Ultra keeps working **while it makes progress**, and reports honestly — with
evidence — the moment it stops. The constraint is evidence, not a round count.

## Acceptance criteria

- Criteria are executable structures: `file_exists`, `content_match`,
  `command_exit`, `test_pass`, `gate_pass`, `manual`.
- Free-text criteria are parsed heuristically; anything that cannot be
  mechanised becomes `manual`.
- **`manual` can never be auto-passed.** The only path to pass is an explicit
  user confirmation, recorded in the ledger.
- Criteria are frozen when the plan freezes. Revisions may add criteria freely;
  dropping a blocking criterion requires a stated reason and is always shown in
  the final report. `manual` criteria can never be dropped.
- Commands from criteria run behind three layers: the exec-policy gate
  (rejection = criterion failure, visible), a configurable allowlist
  (off-list = downgraded to `manual`, never executed), and the gate runner
  (no shell, timeout kill, output captured as evidence).

## The round loop

- Rounds: (replan) → scaffold → coding → debugging → validation → gates →
  goal verification. Intake/preview/blueprint/git-branch run once.
- `ultra.max_rounds` defaults to `0` (unbounded). Backstops: stall detection
  (`ultra.no_progress_rounds`, default 2), `ultra.deadline_ms` (default 2h),
  `max_iterations` (total LLM turns), and the token budget.
- Progress signals (any one counts): a criterion or gate flipping to pass,
  newly completed tasks, stage advance, file changes whose error signatures are
  not verbatim repeats. File churn with identical errors is **not** progress.
- Stage failure disposition: retry / degrade / defer / skip / replan / abort.
  Only a user stop or an unrecoverable plan defect abandons remaining work.
- Replans are capped (`ultra.stage_failure.max_replans`, default 2), receive
  the ledger's failure evidence, may only revise remaining stages, and a plan
  with an unchanged structural signature is rejected.
- `ultra.goal_mode: false` restores the exact 0.4.x single-round behaviour.

## Blocked behaviour

- In a TTY, Ultra pauses with the report and asks: continue / give guidance /
  deliver what is done / stop. Guidance enters the next round as top-priority
  context. Pending `manual` criteria are asked inline.
- Headless: the answer void is never interpreted as "continue".
  `ultra.on_blocked_non_tty` (default `deliver_partial`) closes the loop; a
  stalled run with zero passing criteria exits `blocked` (code 2).

## Statuses and exit codes

| status | meaning | exit |
| --- | --- | --- |
| `completed` | all blocking criteria pass and gates pass | 0 |
| `partial` | some criteria pass; work delivered | 0 |
| `blocked` | stalled or immediately blocked; report says why | 2 |
| `blocked_manual` | only human judgments remain | 3 |
| `user_stopped` | stopped on request | 0 |
| `budget_exhausted` / `deadline_exhausted` | backstop hit | 4 |
| `needs_objective` | prompt is not an actionable objective | 2 |
| `fatal` | internal error (the only status that marks the session failed) | 1 |

`[TASK_COMPLETE]` is a model self-report and on its own never yields
`completed`. Git merge to the base branch happens only on `completed`.

## Artifacts

- `.kkcode/ultra/<session>/ledger.json` — per-round attempts, dispositions,
  criteria verdicts with evidence, gate outputs, interactions.
- `.kkcode/ultra/<session>/report.md` — the rendered goal report.
- `kkcode ultra report|board|plan|resume [--guidance]` read these.
