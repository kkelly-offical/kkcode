# 1.0.1 stable completion ledger

Baseline: public `1.0.1-preview.2`, main `3511782`.
The user authorized a stable `1.0.1` release after these additions and acceptance:

- [x] Android GitHub update source: check/channel selection, bounded download,
  package/hash/certificate verification, explicit Android install consent and
  retry/cancellation handling. Enterprise update management is deferred.
- [x] Dedicated local Ubuntu VM connected to `https://coding.internal.zzheng.cn`;
  user completes the device-grant browser approval. Keep the remote hub in a
  visible foreground terminal, not an auto-start exposure service.
- [x] Web and Android pixel visual theme, inspired by the existing Jianwei case
  workspace: monochrome surfaces, restrained pixel texture, crisp borders and
  stepped corners. Preserve existing control positions, sizes and functionality;
  keep semantic diff/status colors and accessibility.
- [x] Stable version `1.0.1` across workspaces; Android code `10004`, existing
  release certificate; signed APK/update manifest, current Web container build.
- [x] Full local/browser/Android/network/package/security and platform CI gates,
  then stable npm/GitHub publication. Do not describe pending work as released.

Only the KK Code checkout and explicitly owned VM/lab resources are modified.
The reference lawyer-workspace source and existing unrelated VMs remain unchanged.
Production gateway deployment is not modified without a separate explicit request.

## Implementation and real checks

- Android: fixed public GitHub source, stable/preview channels, 12-hour foreground
  check/manual check, retry/cancellation/progress, bounded metadata/download and
  package/hash/certificate verification. No enterprise update backend. Current
  version remains a profile entry at the existing location; no startup form.
- Theme: reference lawyer workspace was read only. Web CSSOM comparisons before
  and after the theme show **148 visible control rectangles unchanged** (0.5px
  tolerance), including desktop/mobile/320px, home/chat/menu/settings, dark/light.
  Android styles change palette/shapes/drawing, not padding/size/control order.
- Final local `release:verify`: **2,870 core tests, 2,869 pass, 1 macOS-only skip, 0 fail**;
  **33 E2E pass**. Lint, kernel types, version/boundary/secret/coverage and installed
  package/SDK/client/protocol smoke passed. Web types and all three browser suites
  also passed. npm production audit: **0 vulnerabilities**.
- Android JVM **47 passed**; Compose UI **26 passed** (includes four updater cases).
  Real enterprise Android cases run separately below, not counted twice as UI.
- Signed self-update acceptance on dedicated `kkcode_101_update_api36` / 5584:
  project-signed 10004 baseline -> private project-signed 10005 fixture. The App
  checked/downloaded/verified the real APK, opened Android unknown-source settings,
  then the system “Update KK Code” confirmation. After confirmation, Android
  reports code 10005 and `installerPackageName=cn.kkcode.remote`. Instrumentation
  is intentionally killed by replacement; a second instrumentation test passed
  and proved settings plus a Keystore-encrypted sentinel survived. No uninstall
  or ADB install of the target version was used. The private fixture is NOT a
  public version/artifact and must never be uploaded.
- Public-target APK was separately rebuilt from the normal checkout as **10004**,
  checked v2/v3/non-debuggable/package/version and installed on separate release
  AVD 5582. Compact home, no configuration form, live process and rejected run-as
  all passed. SHA-256:
  `dc5ce364453a66e2a54a0571054e5fe86ed633d03fbfaece8752815342ecac7a`.
  Size 52,485,479 bytes after the user-requested brand icon; unchanged project certificate; generated matching
  `android-update.json`. Private key remains outside Git/CI.
- User-provided product concept art is retained under `docs/assets/brand` and
  included in README. The first square image was adapted using built-in imagegen
  into the Android launcher master; the original is preserved. Adaptive XML
  margins handle circle/squircle cropping; it is not a replacement conversation
  layout. Prompt/tool/provenance notes and a resource consistency test are included.
- Rebuilt local gateway/Web image `kkcode-enterprise-lab-gateway:1.0.1` from the
  current source. The full deployed Keycloak/PostgreSQL/HTTPS integration passed
  in `integration-ghpjfY` and again after the SSE fix in `integration-YuTOzx`: CLI/SDK/Web/Android model/session/mode sync, real binary
  attachments, slash policy, cross-client approvals, private sharing/revocation,
  verified SSH, branch actions, gateway restart/replay, foreground stop, unbind
  and account/history transfer. Production gateway was not redeployed.

## Bound demo VM and vLLM

- Dedicated Ubuntu 24 VM `kkcode-remote-demo`, 2 CPU / 4 GiB RAM; IP
  `192.168.122.111`. User approved browser SSO and ordinary-folder scope. Remote
  status reports connected and `folderAccess: all`, roots `/home/kkcode` and `/`.
  Credential/system-private paths remain protected. No host folder was mounted.
- Hub stays in VM tmux `kkcode-remote`; exiting it stops exposure. A separate
  narrowly scoped SSH reverse tunnel plus VM loopback TLS adapter reaches the
  already running host model. Only that hub/CLI process trusts its dedicated CA.
- Discovery with only `base_url` and `api_key` returned network catalog model
  `Qwen3.8-27B`; actual CLI agent/session inference succeeded with a bounded canary.
  Saved endpoint is `https://127.0.0.1:18540/v1` on the VM. Keys are not recorded
  here. No built-in model list or hardcoded model ID was used for discovery.
- Two real compatibility failures were fixed: server-rejected default `high`
  reasoning effort and multiple system messages. OpenAI now preserves unspecified
  server defaults and sends one leading system message with cacheable text blocks.
  Explicit configuration and Anthropic defaults remain supported.
- GPU skill checks confirmed the existing H100/CUDA runtime; no GPU allocation,
  service restart, model reload or inference parameter tuning was performed.

## Hosted gates and failed attempts

- Initial local test failure was an old English error-message assertion; changed
  to structured `path_denied`/403 plus actionable localized text checks.
- [Acceptance 35741776982](https://github.com/kkelly-offical/kkcode/actions/runs/35741776982)
  on `dc90560`: both Ubuntu jobs and macOS passed. Windows failed one pre-existing
  full-kernel approval test's 6-second wait. Its bounded budget is now 30 seconds,
  and a prematurely ended parent produces an immediate diagnostic instead of a
  misleading timeout; all approval/cancellation assertions remain. Rerun pending.
- [CodeQL 35741782371](https://github.com/kkelly-offical/kkcode/actions/runs/35741782371)
  completed all three languages, including a real Kotlin build. Open static
  findings: 17 reviewed, not zero; see [security review](security-review-1.0.1.md).
- The second macOS run exposed a real SSE race (not a platform skip): an initial
  or gap replay can overtake an already queued live row. The live operation used
  to check its cursor only before enqueue, allowing duplicate output/cursor
  rollback afterwards. It now checks `closed` and `row.seq <= cursor` inside the
  serialized operation. Three deterministic interleaving tests cover initial
  replay, gap repair and close-with-queued-work. Full gates are rerun for this
  additional runtime fix; the earlier 2,866-test count predates these three tests.
- The next Windows run passed core/E2E/package gates, then exposed a Web modal
  first-paint focus/Escape race. A MutationObserver-driven browser test reproduced
  it locally (`data-sheet-focus-ready=false`, Escape left the dialog open).
  Sheet focus/inert/listener setup now uses layout effects before first paint;
  the same regression passed after the fix, without forced test focus or relaxed
  assertions. All three Web suites, Web types and the 148-control layout check
  passed again. The final main revision is sent through hosted gates before tagging.

## Publication

Source `c04fcaf` is merged into main. The following final hosted gates all passed:

- [main verify 35745789404](https://github.com/kkelly-offical/kkcode/actions/runs/35745789404):
  four platform/Node jobs and the Web job.
- [full enterprise acceptance 35745791088](https://github.com/kkelly-offical/kkcode/actions/runs/35745791088):
  all four platform/Node jobs, including the three browser suites on Windows.
- [main CodeQL 35745789821](https://github.com/kkelly-offical/kkcode/actions/runs/35745789821):
  all three languages, with actual Android/Kotlin compilation. The 17 reviewed
  static findings remain visible; no blanket rule suppression.

| Platform | Core tests (2,870) | Separate E2E | Web / package / SDK |
| --- | --- | --- | --- |
| Local Linux / Node 24 | 2,869 pass / 1 skip | 33 pass | Passed |
| Hosted Ubuntu / Node 22 | 2,864 pass / 6 skip | 33 pass | Passed |
| Hosted Ubuntu / Node 24 | 2,864 pass / 6 skip | 33 pass | Passed |
| Hosted macOS / Node 22 | 2,863 pass / 7 skip | 32 pass / 1 skip | Passed |
| Hosted Windows / Node 22 | 2,854 pass / 16 skip | 32 pass / 1 skip | Passed |

Skipped cases reflect OS-specific sandbox/PTY/POSIX/Unix-process paths, not passes.
Windows's new ordinary-volume consent parser test runs; Linux-only private
`/proc`/`/dev` checks are deliberately skipped off Linux. Android results and
real signing/installation/network evidence are recorded separately above.

The final lab rerun `integration-AROmJq` also passed after the modal focus fix.
The dedicated VM was confirmed connected with zero active sessions before
preparing its package update. Public GitHub update checking on the release AVD
correctly reports no compatible manifested Android release before publication.

Tag `v1.0.1` points to `c04fcaf`. The protected
[release workflow 35747008242](https://github.com/kkelly-offical/kkcode/actions/runs/35747008242)
succeeded on its second attempt. Final public artifact and installed-VM receipts
follow below; the first failed attempt is retained for audit.

The first release-matrix attempt hit a pre-existing Windows timing test:
`background-manager-wait` expected real disk-backed settlement inside 500 ms.
Its timeout legitimately returned null on that runner; the same runtime had
already passed two full Windows gates. The unchanged tag is rerun, not moved,
and no tests are skipped. Separately, test-only main commit `11c5351` replaces
10/40/200 ms sleeps with explicit task gates, checks that an unrelated settlement
cannot resolve the watched wait, and drains every worker before restoring its
fixture directory/environment. The three-case suite passed 20 consecutive local
runs. There is no runtime/workspace/package configuration difference between
the release tag and that follow-up commit; this is post-tag test maintenance,
not a claim that the immutable tag contains the new test file.

### Public release receipts (2026-09-22)

- GitHub [v1.0.1](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.1):
  normal release, not draft/prerelease, and returned by GitHub's latest-release
  endpoint. Includes signed APK, `android-update.json`, `SHA256SUMS` and CycloneDX
  SBOM. Release notes include the user-provided product banner and upgrade guide.
- npm publication was accepted at 15:38 UTC and became visible in the public
  registry at **15:43:06 UTC**. Registry and plain `npm view` both confirm
  `latest: 1.0.1`, while `preview: 1.0.1-preview.2` remains unchanged. The transient
  pre-index 404 was observed and waited out, not described as a completed install.
- Public npm tarball: **3,573,240 bytes, 499 files**, SHA-256
  `632301dc4fa27bf237bf5573db92088b2d9f4e7a226bc8f7724ab61542a4191b`.
  The independently downloaded registry tarball is byte-identical to the CI
  artifact and passed immutable package/secret/installed-SDK verification again.
- Public APK: **52,485,479 bytes**, SHA-256
  `dc5ce364453a66e2a54a0571054e5fe86ed633d03fbfaece8752815342ecac7a`.
  Public manifest SHA-256:
  `fcfa6d41d16c1f51fcd9373d48ccbf54a85f14d709b3e8499c0a81d10a9f4d7f`.
  GitHub asset digests and separate anonymous HTTPS downloads both match the
  checked local files. No debug/test-10005 artifact or private key was uploaded.
- The actual installed signed Android 1.0.1 App checked the public GitHub source
  after upload and reports “已安装当前渠道的最新兼容版本”. Screenshot:
  `test-results/android-update-published.png`. This is an actual App network
  request, not only a host-side manifest fetch or mocked release list.
- VM `kkcode-remote-demo` now runs the public npm **1.0.1**. The new installation
  was staged while the old hub stayed online, swapped only after an idle check,
  and restarted in the same foreground tmux session. Device identity, login,
  ordinary-folder scope, model configuration and history were retained. The
  prior installation remains at `/home/kkcode/.local/kkcode-before-stable-1.0.1`.
- Public CLI `model test --provider local-vllm --probe --json` rediscovered
  `Qwen3.8-27B` from the network and completed inference. Full `chat` using the
  configured provider succeeded with `turn.result` / schema 1 / status succeeded
  and exact `KKCODE_STABLE_OK` content, no tools and no error. The chat provider
  selector is `--provider-type`; an initial manual check used `--provider` by
  mistake and was corrected, not treated as a product failure.
- After upgrade the VM is connected, `/opt` remains browsable and `.ssh`, KK Code
  credentials, `/proc/self` and system SSH paths remain denied. The production
  cloud gateway was not replaced; its administrator can rebuild from the stable
  source to deploy the new Web theme. The lab image was rebuilt and verified.
- Follow-up test-only [verify 35748102459](https://github.com/kkelly-offical/kkcode/actions/runs/35748102459)
  and [CodeQL 35748102421](https://github.com/kkelly-offical/kkcode/actions/runs/35748102421)
  both passed all jobs on `11c5351`. Closeout documentation does not change the
  released runtime, tag, APK or npm tarball.
