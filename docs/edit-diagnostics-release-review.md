# Review Notes: Edit / Diagnostics / Observability Tranche 1

This review note records the highest-value code-quality checks for the approved v0.1.10 Tranche 1 work.

Grounding:

- `.omx/plans/prd-kkcode-multi-angle-catchup.md`
- `.omx/plans/test-spec-kkcode-multi-angle-catchup.md`
- `docs/agent-longagent-compat-review.md`
- `docs/agent-longagent-compat-extension-guide.md`

## Overall verdict

The tranche is worth shipping **only if the diagnostics layer stays additive**:

- keep existing edit-safety semantics intact
- keep LongAgent as the structured implementation lane
- make diagnostics results concise, comparable, and reusable

## Scope discipline from the current repo state

Tranche 1 code has now landed for the `v0.1.10` release line. Release-facing docs should describe the shipped diagnostics/observability feedback honestly, while still avoiding claims about later tranches that have not been implemented yet.

For now, the safest documentation posture is:

- document the shipped tranche accurately: structured mutation metadata, baseline/post-edit diagnostics deltas, delegated task edit feedback, and bounded summaries
- keep later-tranche claims (broader runtime/task/worktree expansion) out of release-facing docs
- ensure README/product copy stays tied to the implemented 0.1.10 surface

## Highest-priority review checks

### 1. Do not let diagnostics weaken mutation safety

The existing unread-file, stale-file, and partial-read protections are part of kkcode's core trust model.

**Merge gate:** a diagnostics pass must run only after the same read-state and mutation-guard rules that already govern `write`, `edit`, `patch`, and related tools.

### 2. Prefer stable summaries over raw log floods

Compiler or diagnostic output can be large and noisy.

**Merge gate:** release output should favor:

- mutation summary
- diagnostics counts
- introduced/persistent/resolved buckets
- truncated actionable samples

Avoid pushing full raw tool output into every terminal reply or background result.

### 3. Degrade gracefully when diagnostics are unavailable

Not every repository has `tsconfig.json`, a typecheckable surface, or a cheap diagnostics engine.

**Merge gate:** missing diagnostics capability must produce an explicit, machine-readable no-op/degraded state rather than:

- pretending the repository is clean
- failing the mutation path unnecessarily
- silently dropping observability fields

### 4. Keep LongAgent feedback informative, not disruptive

LongAgent should learn from diagnostics deltas, but not be forced into a heavier or more confusing execution contract.

**Merge gate:** the new feedback loop should enrich stage/gate context without replacing ownership, plan discipline, or gate decisions.

### 5. Make delegated/background reuse explicit

The PRD calls for a reusable contract that later background/task flows can consume.

**Merge gate:** direct edit results, background task results, and delegated task summaries should agree on the same minimal vocabulary for:

- changed files
- added/removed lines
- whether diagnostics were attempted
- the diagnostics delta summary

## Recommended smoke checks

1. edit a file with no diagnostics support available
   - expected: mutation summary present, diagnostics marked skipped/degraded
2. edit a typed file that resolves one error and introduces one new error
   - expected: resolved and introduced buckets both populated
3. run the same path through delegated/background execution
   - expected: deterministic status/result retrieval, not log guessing
4. run a LongAgent flow after the change
   - expected: ownership and gate semantics unchanged

## Suggested release checklist

- [ ] mutation tools still return structured patch metadata
- [ ] diagnostics contract distinguishes not-attempted vs attempted-clean vs attempted-with-issues vs degraded
- [ ] typecheck/diagnostic output is bounded and human-readable
- [ ] no regression in unread/stale/partial-read protections
- [ ] delegated/background result reuse is documented
- [ ] docs clearly say this work strengthens feedback loops without replacing LongAgent

## Remaining risk to watch

The main risk is not correctness of a single edit, but **feedback-path drift**:

- one code path returns detailed diagnostics objects
- another returns only raw strings
- a third silently skips diagnostics

If that drift appears, later background/task reuse will become harder and the user-facing semantics will feel inconsistent. The safest path is to keep one minimal shared diagnostics contract and let richer surfaces build on top of it.
