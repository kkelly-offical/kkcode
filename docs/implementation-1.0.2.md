# 1.0.2 implementation and acceptance ledger

Status: **published stable 1.0.2**, tag `v1.0.2` at `a820086`.
Baseline: `52ae793`. Development notes below are chronological; final public
receipts are at the end. Post-release documentation commits do not move the tag.
The published `v1.0.1` tag and release remain immutable.

## Authorized scope

- Repair the audited SVG/image, MCP result, history-recovery, preview and tool-description gaps.
- Add visible conversation rewind and session rename/archive/unarchive on Web and native Android.
- Expose detailed branch selection and safe Git worktree creation/selection.
- Consolidate behavior into Plan, Agent, Auto, Ultra and Yolo. Hide independent approval selectors and terminal shortcut hints on Web/Android. Preserve old API/CLI spellings as aliases.
- Auto edits normally; sensitive operations receive a bounded, tool-free review by the same provider/model as the current conversation. Policy denials are never overridden. Uncertain or unavailable review falls back to a user decision, not silent approval.
- Generate a title from the first real question using that turn's conversation model; manual names win over asynchronous title generation.
- Deliver built-in browser development tools using a maintained browser engine, with explicit scope, isolated contexts, screenshots, semantic page inspection and interactive actions. No implicit attachment to a user's personal browser profile or credential store.
- Validate the kernel, SDK/device API, CLI, Web, Android and real demo VM before publishing 1.0.2. Android public versionCode must advance to 10005 with the existing release certificate.

## Work sequence and gates

1. Shared media/tool-result contracts: decode/format/size limits; SVG source and safe raster preview; invalid historical media recovery; MCP multimodal blocks; authenticated preview projection. Tests must reproduce the reported SVG → 400 → text-retry failure.
2. Session contract: metadata mutations, archived visibility, same-model title generation with rename races, complete-turn rewind and old tool-event removal; file rollback remains separately confirmed.
3. Unified modes and Auto review: canonical labels/aliases, one behavior selector, deterministic hard boundaries, bounded model review, auditable outcomes and cancellation.
4. Git workspace contract: detailed local/remote refs, clean/stale/active-turn checks, worktree list/create/open; no force/reset/clean, automatic stash, push or destructive worktree removal.
5. Browser tools: lazy startup, isolated context per session, bounded page/screenshot results, explicit local-dev access and public-network safety. Browser setup must be actionable when no compatible engine is installed.
6. Web and Android parity: compact menus, rename/archive/restore, rewind confirmation, branch/worktree sheets, media previews, consistent modes and no terminal keyboard labels. Preserve the established pixel theme and primary layout.
7. Acceptance and publication: focused regressions, full release verification, real browser workflows, Android JVM/UI/signed-install checks, hosted Linux/macOS/Windows checks, documentation and immutable artifacts. Publish only after the required gates pass.

## Evidence

- Shared media decoder and static SVG renderer implemented using pinned Sharp
  and xmldom. SVG defaults to editable text, explicit preview renders bounded
  pixels; MCP media and structured results survive the executor; invalid old
  media is quarantined in request projections without deleting source history.
  Authenticated `media.preview` and byte-free history references are present.
  Focused media/history suite: 44 passed. Old corrupt PNG fixtures and the test
  that required extension-based MIME mislabelling were corrected.
- Session rename/archive/restore and rewind RPCs are implemented. Rewind now
  recognizes mixed tool/media messages, removes corresponding tool parts,
  rejects stale views and retains a private `before-rewind` backup. Same-model
  first-question title generation uses compare-and-set to protect manual names.
- Canonical mode is now `auto` (`agent-auto` remains an input alias), with Auto
  review tied to the current conversation provider/model. Reviews are tool-free
  and bounded; policy/protected-path decisions are not overridden, malformed
  verdicts fall back to human confirmation, and review usage enters turn totals.
  Combined focused session/mode/review suite: 30 passed. No claim yet of the
  complete real-model Auto workflow or client parity acceptance.
- Branch detail and worktree list/create/open APIs implemented, including cached
  remote refs and committed-base selection. Worktree creation preserves dirty
  source files; opening a worktree creates a separate session. Added Git 2.34
  porcelain fallback after detecting the local Git lacks `worktree list -z`.
  Checkout disables filters from initialized submodules as well as the parent.
  Branch/worktree regression suite: 13 passed on local Linux.
- Built-in Browser real-engine suite: 4 passed (open/fill/click/screenshot,
  independent cookies, blocked private cross-origin/redirect/metadata/file
  targets). Browser is lazy, per-session and closed at kernel shutdown.
- Web two-client real DeviceService acceptance passed rewind/rename/archive/
  restore, authenticated legacy SVG preview, unified Auto and dirty-source
  worktree create/open. Pixel-theme regression compares 154 control rectangles
  against the unthemed layout; all unchanged after moving interaction geometry
  out of the theme-only stylesheet. Existing full Web contract smoke passed.
- Android JVM/debug builds passed; native emulator UI/HTTP contract pass: 39
  instrumented test cases, 6 separate enterprise/TLS/release-update cases gated
  out of this invocation, 0 failures. Those opt-in cases are not counted as
  completed production/network/update acceptance here.
- Initial core suite found 13 failures: obsolete mode/picker expectations,
  fake header-only PNG fixtures, an old MCP-output assertion and command mock.
  Corrected regressions: 65 passed. No weakening of full-pixel media validation.
- Asynchronous title usage is now counted without inventing an extra chat turn;
  usage writes are cross-process locked to avoid overwriting concurrent totals.
  Auto decisions persist as session parts, rather than disappearing on reload.
- Production dependency audit: 0 vulnerabilities. The first release gate stopped
  on deleted, tracked hashed Web assets still present in the Git index; the
  secret scanner correctly failed closed. Its protection is unchanged; rebuilt
  assets must be staged consistently before rerunning the release gate.
- Full local `release:verify` passed after staging generated assets: 2,905 core
  cases (2,903 passed, 2 conditionally skipped, 0 failed), 33 E2E passed, packaged
  install/secret scan and installed kernel/SDK/protocol imports passed. Coverage:
  83.02% lines, 79.04% branches, 81.21% functions. Late full-kernel Auto workflow
  regression separately passed and will enter the next complete CI run.
- Compatibility matrix: 45 passed. Real lab `integration-7Ovi4i` passed CLI SSO,
  loopback/WireGuard Web sync, both provider protocols/media, cross-client
  approval/sharing/revocation, native Android login/model/conversation/documents/
  branches, verified SSH, foreground shutdown, unbind and account transfer.
  Chromium needed an explicit lab-only proxy bypass; Android used the existing
  isolated cellular-network test path to avoid the emulator Wi-Fi proxy. Host
  proxy settings and production TLS validation were not changed.
- Signed 1.0.2/10005 APK passed v2/v3 certificate verification and in-place
  installation on the dedicated release AVD; compact home launches and run-as
  access is rejected. A final rebuild will be verified again after the last
  client-contract cleanup; no private update fixture will be published.
- VM candidate package installed separately without replacing the running hub.
  Three bounded real requests to local `Qwen3.8-27B` passed historical SVG visual
  recognition, corrupt-image-history continuation and same-model Auto review.
  SVG source/read-state and safe PNG rendering also passed on that device.
- Development commit `16bcb9a` pushed to main; hosted verify and CodeQL started.
  Web/Browser job passed. Follow-up review found a cold-cache-only MIME mismatch
  (valid PNG declared as SVG) hidden by a warm-cache test order; now actual bytes
  determine SVG detection. Replaced grouped base64 regex with a bounded linear
  validation path and added a 4 MiB case. Media regression: 32 passed.
- First hosted matrix exposed the same pre-existing trust re-grant failure as
  baseline `52ae793` on both macOS and Windows: an alias revocation tombstone
  overrode a subsequent canonical exact grant. Canonical trust records now have
  explicit precedence, exact grants use physical paths, and a Linux-reproducible
  symlink regression checks that a re-grant does not restore recursive scope.
  No platform test is skipped to get past this failure; full hosted rerun pending.
- Versions are prepared as 1.0.2 / Android 10005. Final docs review, full gates,
  real-model/demo rollout, hosted OS matrix and signed-update validation remain
  in progress.
  At that development checkpoint no 1.0.2 package/APK/tag had been published.

## Release candidate acceptance

- Runtime candidate `5bb8115`: local release gate **2,909 core cases, 2,907
  passed, 2 conditional skips, 0 failures**; **33 E2E passed**; npm artifact
  installation, source/index/payload secret scans and SDK exports passed.
  Coverage 82.99% lines / 79.07% branches / 81.24% functions.
- Web real-device and mocked-contract suites passed; pixel-theme comparison
  checked 154 control rectangles. Built-in Browser real-engine suite: 4 passed.
  Extension/MCP interoperability suite: 45 passed.
- Native Android focused UI + HTTP contract: **30 passed**, including the new
  session menu/restore, file-preserving rewind confirmation and Worktree UI.
  Actual Keycloak/HTTPS Relay/SSH native suite: **3 passed** in
  `integration-7Ovi4i`, not a mock SSO result.
- Exact reported `pelican-bicycle.svg` on the demo VM renders to **800×600 PNG**
  without modifying its source. Local `Qwen3.8-27B` discovery was verified with
  `source=network`; real SVG vision, poisoned-history recovery and same-model
  Auto review all passed. No production model parameters or gateway deployment
  were changed.
- The idle demo VM now runs the separately installed 1.0.2 candidate in its
  foreground tmux hub and is connected to the existing production gateway. Old
  install prefix remains available for rollback. The production gateway/Web
  must be upgraded separately to expose the new client UI and RPC methods.
- Signed APK: `1.0.2` / `10005`, **52,567,399 bytes**, SHA-256
  `6a78ae02414aa464085908f273f77c72b1cf6669ea35c20c1a7e4e348eb72d76`.
  Existing project certificate, v2/v3 verified, not debuggable; installed over
  the dedicated release AVD successfully. Manifest is generated from this APK.
- CodeQL on `5bb8115` passed JavaScript/TypeScript, Actions and real Kotlin
  extraction. All five new findings from the first candidate closed after code
  fixes, leaving the same 17 reviewed pre-existing open alerts. No rules were
  disabled or findings manually dismissed.
- Hosted follow-up corrected an old test that opened a lexical rather than
  canonical trust-record path, and a remote event assertion that incorrectly
  required `turn.result` to follow asynchronous `session.title.updated`.
  The stable headless JSONL last-line contract remains unchanged and tested.
  Final hosted all-platform status and public receipts will be appended below.

## Public release receipts (2026-09-23 local time)

- Final main [verify 35779305779](https://github.com/kkelly-offical/kkcode/actions/runs/35779305779)
  and [CodeQL 35779305753](https://github.com/kkelly-offical/kkcode/actions/runs/35779305753)
  both succeeded on `a820086`. Linux Node 22/24, macOS, Windows and Web/Browser
  gates all passed. macOS: 2,901 core passes / 8 OS/engine skips, 32 E2E passes /
  1 platform skip. Windows: 2,892 core passes / 17 OS/engine skips, 32 E2E passes /
  1 platform skip. Conditional skips are not reported as successful executions.
- Immutable tag `v1.0.2` points to `a82008623b28302b253995831a3f0f2bdc036d3f`.
  [Release workflow 35780804374](https://github.com/kkelly-offical/kkcode/actions/runs/35780804374)
  repeated its four-platform matrix and full release/package/audit gates, then
  published npm and GitHub successfully. `v1.0.1` remains at `c04fcaf`.
- [GitHub v1.0.2](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.2)
  is a normal latest release, not draft/prerelease (published 20:40:15 UTC on
  September 22). Signed APK, `android-update.json`, `SHA256SUMS` and CycloneDX
  SBOM are attached; public downloads match their locally verified hashes.
- npm publication became independently readable by 20:47 UTC after a brief
  post-publish indexing delay. Public `npm view` confirms `latest: 1.0.2` and
  unchanged `preview: 1.0.1-preview.2`. No duplicate publication was attempted.
- npm tarball: **3,626,308 bytes / 514 files**, SHA-256
  `32f603dd3c9783b5a118c899f4e4fd08315ee891aeb891d800a08c2b0075a48f`.
  Independently downloaded registry tarball is byte-identical to the CI artifact;
  immutable payload scanning, clean installation and SDK export verification
  passed again. Public manifest SHA-256 is
  `98341e4d809bfda4eb9e3c8776cdd4c844900062ab501518dffbfa93974c7285`.
- Final local enterprise image digest:
  `sha256:9d9f80dd07f5a567aa66b73983f7a929b4c8fbcc7b5b812f5639e5185ccdaf01`.
  Repeat acceptance `integration-Kg1czJ` passed the full real Keycloak/Relay/Web/
  Android/SSH/model/media/approval/lifecycle suite against that image.
- The idle demo VM was upgraded from the **public npm registry**, and its
  foreground hub restarted from `/home/kkcode/.local/kkcode`. CLI reports 1.0.2
  and Relay is connected. Binding, UUID/IP, model config and ordinary-folder/
  recursive-project trust remain unchanged; the previous install is retained at
  `/home/kkcode/.local/kkcode-before-1.0.2`.
- The production gateway domain was not redeployed by this task. Its operator
  must update the gateway/Web image as well as the device/App for the new Web UI
  and additive RPC methods. The live demo device update is not a claim that the
  organization's production gateway image has also changed.
- The installed non-debuggable, project-signed Android 1.0.2 App completed a
  manual check against the public GitHub source and displayed “已安装当前渠道的
  最新兼容版本”. Screenshot: local `test-results/android-update-1.0.2-public.png`.
  This is an actual update-source check, separate from the earlier signed APK
  installation and isolated installer fixtures.
