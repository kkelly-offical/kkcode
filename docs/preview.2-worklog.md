# 1.0.1-preview.2 implementation and acceptance ledger

Baseline: `5d7dd60` (M32/M33 merged). User authorized completing the remaining
work, updating README and supporting documentation, then publishing the third
preview through npm `preview` and a GitHub prerelease. Stable `latest` remains
`1.0.0`; no major/minor version change is authorized.

## Work and acceptance gates

- [x] Cross-platform fixes: explicit ripgrep dependency, actionable missing-tool
  errors, canonical Windows path assertions, investigate macOS completion.
- [x] Media: bounded cross-platform clipboard media/file reading, adapter
  serialization, capability/format checks for TUI and line mode, rejection
  without false attachment success, tests that inspect actual HTTP bodies.
- [x] Catalog: provider-scoped discovered pricing in cost/budget accounting,
  capability/source badges in model selection, no claims of inference probing.
- [x] Remote: forward safe `mcp.loaded` summaries to authorized clients without
  changing headless JSONL; verify live delivery and teardown.
- [x] M28 follow-ups: deferred `tool_search`, root-to-cwd instruction loading,
  canonical tool advertising with backward-compatible aliases, structured task
  brief, and remaining skill invocation/restriction semantics.
- [x] Documentation: README, configuration/help, SDK/protocol, media, enterprise
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

## Failures investigated, not waived

- Baseline Windows/Linux search tests depended on a missing runner executable;
  CI now installs ripgrep and product errors identify the missing dependency.
- Windows folder expectations ignored canonical short/long path differences.
- The macOS controlled-terminal test used the runner's long hostname, which the
  UI correctly truncated; its failing assertion also left the terminal alive.
  The test uses a deterministic fixture and always tears down in `finally`.
  A separate real start/stop race in the panel is fixed and regression-tested.
- Native media could be reported attached without being encoded. Provider-wire
  tests now compare actual bytes; rejected drafts stay available to the user.
- The expanded native run exposed a missed media guard in Anthropic token
  counting. Counting and inference now share it, allowing continued conversation
  after switching a media-containing history to a text-only protocol.
- Android incorrectly deduplicated same-id SSE control frames. Only durable
  `seq` values advance the journal cursor now; hello/state/gap frames still apply.
- The shared emulator Wi-Fi daemon inherited an external proxy. The dedicated
  debug AVD's emulated cellular path passed normal TLS and all real network
  tests; no global proxy, route or trust-all change was made.
- Device-grant response URLs were passed directly to Web navigation. All clients
  now construct the fixed login path; CLI/SDK/Android credential requests cannot
  follow redirects. Public discovery can follow bounded, validated canonical
  origin redirects without credentials. See the [security review](security-review-1.0.1-preview.2.md).
- One local verification overlapped a Web rebuild before the renamed bundle was
  staged. The secret scanner correctly failed on the missing old indexed file;
  the generated bundle was committed and the full gate rerun, not bypassed.

## Completed acceptance evidence

- Final local `npm run release:verify`: 2,857 Node tests / 2,856 passed /
  1 platform-only skip / 0 failures; coverage lines 83.02%, branches 78.80%,
  functions 81.34%. E2e 33/33, stable headless JSONL, lint, core/Web typechecks,
  import/stdout boundaries, bundle build and secret scans all pass. Installed
  package smoke covers 490 files and kernel SDK/browser/protocol exports.
- Web real device API and browser contract suites pass, including actual
  attachment bytes, branch mutations, model/settings actions, 320px layout,
  layered settings, live history and hostile login-response navigation.
- Android: 35 JVM tests, 22 Compose UI tests, 1 normal-TLS probe, real native
  enterprise network suite (3 tests), signed
  APK installation/startup on separate AVD 5582, v2/v3/certificate/non-debuggable
  checks pass.
- Full Keycloak/PostgreSQL enterprise run passed in private
  `integration-cKaqjE`: CLI/dual Web/SDK/Android, WAV/MP4 transport, protocol switch,
  approval, cancellation, SSH, branches, sharing, gateway restart, exact-ID
  unbind, retired-token rejection and explicit account/history transfer.
- Direct WireGuard HTTPS Host, real Dex PKCE/JWKS/groups/refresh/logout,
  two-process gateway failover plus DB-connection recovery, and encrypted
  PostgreSQL backup/isolated restore all pass. Original databases were not restored
  over; temporary test DBs/processes were removed and encrypted backups retained.
- Live Kimi Code catalog and one bounded K3 text inference pass. No claim of
  semantic video/audio inference across every commercial provider is made.
- Official MCP/Skills/plugin compatibility: 45 tests pass.
- Official npm registry audit: 0 advisories (all severities); this is not a
  container/Android/SSO infrastructure audit.
- Before the last redirect hardening, acceptance run
  [35726380157](https://github.com/kkelly-offical/kkcode/actions/runs/35726380157)
  passed all four OS/Node jobs and CodeQL
  [35726497516](https://github.com/kkelly-offical/kkcode/actions/runs/35726497516)
  passed JavaScript, Actions and a real Kotlin build. Final-source runs are
  [35727391416](https://github.com/kkelly-offical/kkcode/actions/runs/35727391416)
  and [35727419569](https://github.com/kkelly-offical/kkcode/actions/runs/35727419569);
  do not infer their result from the preceding commit.

Release APK: `cn.kkcode.remote`, `1.0.1-preview.2`, code `10003`.
SHA-256 `1c51cf69ccb9474218d7a370f6ee400d83f0f834e0e429186403be84b6f96738`.
Existing certificate SHA-256
`cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`.
Keys/passwords stay outside Git/CI. Publication is tracked separately from builds.
