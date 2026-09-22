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
- [ ] Full local/browser/Android/network/package/security and platform CI gates,
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
- Local `release:verify`: **2,866 core tests, 2,865 pass, 1 macOS-only skip, 0 fail**;
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
- Final public APK was separately rebuilt from the normal checkout as **10004**,
  checked v2/v3/non-debuggable/package/version and installed on separate release
  AVD 5582. Compact home, no configuration form, live process and rejected run-as
  all passed. SHA-256:
  `7dfe14716c4edf6dd140755bf20b23ef2cba2c42023319987c57da38b6240bf3`.
  Size 50,778,439 bytes; unchanged project certificate; generated matching
  `android-update.json`. Private key remains outside Git/CI.
- Rebuilt local gateway/Web image `kkcode-enterprise-lab-gateway:1.0.1` from the
  current source. The full deployed Keycloak/PostgreSQL/HTTPS integration passed
  in `integration-ghpjfY`: CLI/SDK/Web/Android model/session/mode sync, real binary
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

## Publication

Pending final hosted gates, merge and release workflow. No stable release is
claimed at this checkpoint. Final npm/GitHub/source/asset receipts follow here.
