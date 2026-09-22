# 1.0.1-preview.2 implementation and acceptance ledger

Baseline: `5d7dd60` (M32/M33 merged). User authorized completing the remaining
work, updating README and supporting documentation, then publishing the third
preview through npm `preview` and a GitHub prerelease. Stable `latest` remains
`1.0.0`; no major/minor version change is authorized.

## Work and acceptance gates

- [ ] Cross-platform CI: explicit ripgrep dependency, actionable missing-tool
  errors, canonical Windows path assertions, investigate macOS completion.
- [ ] Media: bounded cross-platform clipboard media/file reading, adapter
  serialization, capability/format checks for TUI and line mode, rejection
  without false attachment success, tests that inspect actual HTTP bodies.
- [ ] Catalog: provider-scoped discovered pricing in cost/budget accounting,
  capability/source badges in model selection, no claims of inference probing.
- [ ] Remote: forward safe `mcp.loaded` summaries to authorized clients without
  changing headless JSONL; verify live delivery and teardown.
- [ ] M28 follow-ups: deferred `tool_search`, root-to-cwd instruction loading,
  canonical tool advertising with backward-compatible aliases, structured task
  brief, and remaining skill invocation/restriction semantics.
- [ ] Documentation: README, configuration/help, SDK/protocol, media, enterprise
  deployment, implementation ledger and release notes agree with the code;
  historical release records remain historical.
- [ ] Release: version consistency (`1.0.1-preview.2`, Android `10003`), full
  local verification, Web/Android acceptance, Linux/Windows/macOS CI and CodeQL,
  immutable package checks, signed APK, preview-only publication and registry
  verification.

## Baseline evidence

- Local Node suite: 2812 total / 2811 passed / 1 platform skip / 0 failures.
- Local e2e: 33 passed; headless JSONL contract checks passed.
- GitHub verify run `35714810954`: Ubuntu 22/24 fail the grep alias test;
  Windows additionally fails three short/long-path expectations. Web passes.
- CodeQL run `35714811263`: JavaScript, Actions and Kotlin pass.
- Audio/video capability enforcement currently replaces media with text even
  when the model declares support; both clipboard reading and adapter encoding
  must be completed before claiming end-to-end support.
- `/paste` currently reports success after an attachment hook returns `null`.

Completed work and the final validation evidence will be recorded below as the
gates actually pass. An unchecked gate is not a shipped capability.
