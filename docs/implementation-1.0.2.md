# 1.0.2 implementation and acceptance ledger

Status: in development; not a release declaration. Baseline: `52ae793`.
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
- Versions are prepared as 1.0.2 / Android 10005. Final docs review, full gates,
  real-model/demo rollout, hosted OS matrix and signed-update validation remain
  in progress.
  No 1.0.2 package/APK/tag has been published.
