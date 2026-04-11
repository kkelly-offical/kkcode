# kkcode v0.1.10 Edit Diagnostics & Observability Contract

This document defines the **Tranche 1** contract for the edit/diagnostics/observability catch-up work approved in:

- `.omx/plans/prd-kkcode-multi-angle-catchup.md`
- `.omx/plans/test-spec-kkcode-multi-angle-catchup.md`

The goal is to make edit results **diagnosable and reusable** without weakening the existing read-before-edit, stale-file, rollback, or LongAgent ownership guarantees.

## Current repo baseline (inspected on top of `v0.1.9`)

Before any Tranche 1 implementation lands, the current repository already provides three useful building blocks:

1. `src/tool/registry.mjs` returns structured mutation metadata for write/edit-style tools, including `fileChanges`, `addedLines`, `removedLines`, and `structuredPatch`.
2. `src/plugin/builtin-hooks/post-edit-typecheck.mjs` already runs a limited post-edit TypeScript check for TS/TSX edits when a local `tsconfig.json` exists, but it currently appends a warning string instead of returning a reusable diagnostics object.
3. `src/orchestration/background-manager.mjs` and `src/orchestration/background-worker.mjs` already expose deterministic task terminal states plus `completed_files`, `remaining_files`, and `file_changes`.

This document therefore describes the **next compatible step**: keep those foundations, but converge them on one minimal diagnostics contract.

## 1. Goals and non-goals

### Goals

- capture a **baseline diagnostics snapshot** before a mutation when diagnostics are available
- capture a **post-edit diagnostics snapshot** after the mutation / post-edit feedback path completes
- compute a **diagnostics delta** that distinguishes introduced, persistent, resolved, and unchanged issues
- keep a **structured mutation summary** that is stable enough for direct tool output, background-task status, and delegated-task results
- make post-edit typecheck/diagnostic feedback readable without forcing LongAgent to adopt a new execution model

### Non-goals

- replacing LongAgent with a lighter delegation runtime
- making diagnostics collection mandatory for every non-code edit
- blocking all edits on full-project diagnostics when a lighter local mutation summary is sufficient
- introducing IDE/LSP-specific assumptions into the core edit contract

## 2. Guardrails

The Tranche 1 contract must preserve the following current properties:

1. **Read-before-edit stays enforced.** Diagnostics are additive feedback, not an escape hatch around mutation safety.
2. **Stale-file protection stays enforced.** A diagnostics snapshot never authorizes a mutation against changed content.
3. **LongAgent ownership stays primary.** Lightweight diagnostics feedback may inform LongAgent, but must not replace stage planning, ownership, or gates.
4. **Graceful degradation is required.** If no `tsconfig.json`, no diagnostics engine, or no relevant file type is present, the tool must still return a useful mutation summary.
5. **Bounded output is required.** Diagnostics feedback must prefer concise summaries plus representative samples over dumping unbounded logs into tool output.

## 3. Shared terminology

| Term | Meaning |
| --- | --- |
| mutation summary | Structured description of what changed: tool, file(s), added/removed lines, and patch summary |
| baseline diagnostics | Diagnostics snapshot collected before the mutation |
| post-edit diagnostics | Diagnostics snapshot collected after the mutation and any relevant post-edit hook(s) |
| diagnostics delta | Comparison between baseline and post-edit diagnostics |
| introduced issue | Absent in baseline, present after edit |
| persistent issue | Present in both baseline and post-edit snapshots |
| resolved issue | Present in baseline, absent after edit |
| unchanged | No meaningful delta, including no diagnostics available both before and after |

## 4. Minimal result contract

Tranche 1 should keep the contract small enough to reuse across direct edits, background work, and delegated task summaries.

### 4.1 Mutation metadata

Mutation-capable tools should continue returning structured mutation metadata of this shape:

```json
{
  "metadata": {
    "fileChanges": [
      {
        "path": "src/example.mjs",
        "tool": "edit",
        "addedLines": 4,
        "removedLines": 2,
        "stageId": "",
        "taskId": ""
      }
    ],
    "mutation": {
      "operation": "edit",
      "filePath": "src/example.mjs",
      "structuredPatch": [
        {
          "type": "replace",
          "oldStart": 12,
          "oldLines": 2,
          "newStart": 12,
          "newLines": 4
        }
      ],
      "addedLines": 4,
      "removedLines": 2
    }
  }
}
```

This part already matches kkcode's edit-safety direction and should remain the foundation for later diagnostics attachment.

### 4.2 Diagnostics metadata

When diagnostics are attempted, tool results should be able to attach a sibling `diagnostics` object under `metadata`:

```json
{
  "metadata": {
    "diagnostics": {
      "attempted": true,
      "baseline": {
        "source": "tsc",
        "ok": false,
        "summary": {
          "errorCount": 2,
          "warningCount": 0
        },
        "issues": [
          {
            "code": "TS2304",
            "file": "src/example.ts",
            "line": 8,
            "column": 13,
            "message": "Cannot find name 'missingValue'."
          }
        ]
      },
      "after": {
        "source": "tsc",
        "ok": false,
        "summary": {
          "errorCount": 1,
          "warningCount": 0
        },
        "issues": []
      },
      "delta": {
        "introduced": [],
        "persistent": [
          {
            "code": "TS2304",
            "file": "src/example.ts",
            "line": 8,
            "column": 13,
            "message": "Cannot find name 'missingValue'."
          }
        ],
        "resolved": [
          {
            "code": "TS2322",
            "file": "src/example.ts",
            "line": 4,
            "column": 5,
            "message": "Type 'number' is not assignable to type 'string'."
          }
        ],
        "unchanged": false
      }
    }
  }
}
```

### 4.3 Required behaviors

The diagnostics contract should support all of the following states:

1. **Not attempted**
   - diagnostics unavailable
   - irrelevant file types
   - explicit skip for performance/scope reasons
2. **Attempted and clean**
   - baseline or post-edit run succeeds with zero issues
3. **Attempted with issues**
   - issue list plus concise counts
4. **Attempted but degraded**
   - command timed out, tool missing, or output truncated
   - return machine-readable status plus a concise human-readable summary

A degraded diagnostics run must not erase the mutation summary.

## 5. Issue identity rules

Diagnostics deltas are only useful if issue identity is stable enough to compare snapshots.

Recommended Tranche 1 issue key:

- `source`
- `code`
- `file`
- `line`
- `column`
- normalized `message`

If an upstream diagnostics engine does not provide every field, missing fields should be normalized to empty strings rather than omitted from the comparison key.

## 6. Human-readable output expectations

Tool output should remain readable in a terminal-first workflow.

Recommended summary shape:

- one-line mutation summary (`edit src/x.ts +4 -2`)
- one-line diagnostics summary (`diagnostics: +1 introduced, 1 persistent, 2 resolved`)
- one-line post-edit typecheck outcome (`typecheck: failed with 1 remaining error`)
- optional truncated detail lines for newly introduced issues

Avoid pasting full compiler output unless the result is explicitly requested or the concise summary would hide the actionable failure.

## 7. Background/delegated task reuse

The contract should be reusable outside direct foreground edits.

### Delegated/background expectations

- background task results may embed the same `metadata.diagnostics` object in their terminal result payload
- delegated `task` summaries may expose a reduced view (`completed_files`, `file_changes`, diagnostics summary counts) while keeping the richer object available for status/result retrieval
- status polling should report deterministic terminal states (`completed`, `cancelled`, `error`, `interrupted`) instead of forcing users to infer diagnostics outcomes from logs

## 8. Test expectations for Tranche 1

The following cases should be covered before release:

1. mutation summary exists even when diagnostics are skipped
2. baseline + post-edit diagnostics produce a delta with introduced/persistent/resolved buckets
3. post-edit typecheck failures are readable and bounded
4. no-op/no-change diagnostics paths are explicit
5. edit safety protections (unread/stale/partial-read) remain unchanged
6. delegated/background result shapes can carry the same minimal diagnostics contract

## 9. Merge gate for release readiness

Treat the edit/diagnostics slice as release-ready only when:

- the mutation summary is still present on successful write/edit/patch flows
- diagnostics feedback never bypasses edit safety checks
- new diagnostics information can be consumed both by humans and by later runtime/task reuse
- LongAgent can surface the feedback without weakening ownership or stage gates
- failures degrade to concise, explicit summaries rather than silent omission or log spam
