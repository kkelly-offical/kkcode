# KK Code 1.0.2 Fix — implementation and acceptance

Technical version: **1.0.3**. Android public version code: **10006**.
Status: **published stable**, tag `v1.0.3` at
`5f65bae6aed5473f69288e62e39254cfa531397d`.

The user authorized this technical patch number on 2026-09-23 so installed
1.0.2 Apps can discover the update without replacing an immutable release.
Release title: **KK Code 1.0.2 Fix**. Tags v1.0.1 and v1.0.2 remain unchanged.

## Scope and root cause

The gateway's confirmation page always linked to WebUI; Android only polled a
device grant and had no browsable return Activity. A process death lost the
pending grant, transient login network failures stopped polling, and slow_down
did not increase the polling interval. Previous native enterprise tests
substituted the browser launcher, so they did not cover browser-to-App return.

## Implementation

- Gateway advertises native-return version 1, accepts a fixed Android return
  target with transaction state and S256 proof binding, and keeps CLI/Web grants
  backwards compatible. The return URI contains no access/refresh token or
  device code. Arbitrary redirect URLs are rejected.
- Successful confirmation, valid SSO cancellation and failed SSO code validation offer a native return
  button and attempt browser navigation. Auth pages are no-store/no-referrer;
  the return page has a nonce-bound script policy. Cancellation is proof-bound.
- Android uses an external browser Custom Tab, a narrowly registered return
  Activity, encrypted durable pending state, bounded transient retries and
  interval/slow_down-aware polling. Credentials and pending-grant removal
  commit atomically. Foreground recovery, cancel and reopen actions are added.
  Completed identity restores even with automatic device connection disabled;
  it does not select a computer. The login-success notice disappears after 5 s.
- An old gateway remains usable through manual App return and an explicit
  upgrade notice. No IdP callback registration or organization database reset
  is required. Production gateway deployment is separate from GitHub/npm.

## Development checkpoints

- Focused Node run: **27 passed** (native return/security/SSO failure/legacy login).
- Local full release verification passed at the pre-SSO-error checkpoint:
  **2916 passed, 2 intentionally skipped, 0 failed**; line coverage **83.05%**;
  separate process E2E **33 passed**; lint/import boundaries/cycles/typechecks,
  secret scans, 518-file package scan and installed SDK/protocol smoke passed.
  CI must verify the final commit, including the additional SSO error test.
- Android JVM: **58 passed**; Compose/native lifecycle smoke: **34 passed**.
  Lifecycle checks cover proof-bound restoration, single-flight callbacks,
  cancellation, durable cleanup and native Intent resolution.
- The new real Android Chrome smoke completed all three scenarios: warm return,
  process death during SSO then cold return, and a real return-button click with
  automatic scripts disabled via test-only CSP. It asserts native foreground,
  new encrypted credential persistence, removed pending state and native
  organization profile. It does not substitute the App browser launcher.
- Real Keycloak/PostgreSQL over WireGuard HTTPS: login, role mapping, atomic
  refresh and isolated logout passed. Web smoke, contract smoke and pixel layout
  check passed (154 existing control rectangles preserved).
- Full real enterprise smoke passed: CLI login/status, local and Relay WebUI,
  model discovery/switching, cross-client approvals, text/PNG/WAV/MP4 transport,
  sharing/revocation and all three native network tests (including SSH).
- The signed candidate passed v2/v3/existing-certificate/non-debuggable checks
  and in-place installation on the release AVD. Final APK rebuild and receipts
  follow the last error-handling change; earlier candidate hashes are not final.
- A browser integration test caught no-referrer turning Chrome form POSTs into
  Origin:null. Only completed pages now use no-referrer; form pages retain
  same-origin policy. The strict Origin boundary was not weakened.
- CodeQL alert **62** on dynamically constructing script source was addressed
  with a completely static script reading the fixed, escaped link. A regression
  asserts transaction state never becomes script source. GitHub reports it
  **fixed**, not dismissed; no security rule was disabled. Pre-existing 1.0.2
  findings retain their historical review and are not claimed to be zero alerts.
- CI, final artifact verification and publication remain pending. Production
  cloud deployment is not implied by these local lab results.

The statements above describe the pre-publication checkpoint; final receipts follow.

## Final acceptance and publication (2026-09-23)

- [Main verification](https://github.com/kkelly-offical/kkcode/actions/runs/35816944237)
  passed Linux Node 22/24, Windows Node 22, macOS Node 22 and Web UI/Browser checks.
- [CodeQL](https://github.com/kkelly-offical/kkcode/actions/runs/35816944233)
  passed JavaScript/TypeScript, Actions and a real traced Android/Kotlin build.
  Alert 62 is fixed, not dismissed; no rules or gates were disabled.
- [Release workflow](https://github.com/kkelly-offical/kkcode/actions/runs/35817780557)
  passed its independent four-platform matrix, full verification, production
  dependency audit, immutable package scan and npm/GitHub publication.
- Local final Node gate: 2917 passed, 2 intentionally skipped, 0 failed; separate
  headless/process E2E 33 passed. The opt-in real Browser suite separately passed
  all 4 tests; the macOS sandbox-exec test runs on the successful macOS CI job.
  Local Node 24 coverage was 83.05%; release CI Node 22 reported 89.57% lines.
  These are runtime-specific coverage outputs, not directly interchangeable.
- Final Android source: 58 JVM tests, 34 UI/lifecycle tests, all three real
  enterprise network tests and all three real Android Chrome return scenarios
  passed. The new auto-connect-off identity test preserves the preference while
  restoring the account/device list without selecting a computer.
- The actual project-signed release APK was installed/launched on the separate
  release AVD; it is non-debuggable and both v2/v3 signatures verify.
- Public update acceptance used the **unmodified public 1.0.2 APK**, code 10005,
  in the owned update AVD: native App UI discovered 1.0.3 on official GitHub,
  downloaded/validated it, requested the real Android installer and completed
  user-confirmed in-place installation. PackageManager then reported
  **1.0.3 / 10006**. This did not sideload the new APK with adb or use a private
  higher-code fixture as the update payload.

### Immutable public artifacts

- [GitHub Release](https://github.com/kkelly-offical/kkcode/releases/tag/v1.0.3):
  **KK Code 1.0.2 Fix**, normal latest release, not draft/prerelease.
- npm `latest` is **1.0.3**; `preview` stays **1.0.1-preview.2**. Registry indexing
  briefly lagged the successful publish; both the exact version and latest tag
  were independently rechecked after propagation.
- npm tarball: **3,636,491 bytes**, **518 files**; SHA-256
  `0d73831a756da73c42e0e260b4caecbbca67d7ab171e97b102d4cee6691491b1`.
  Public registry SHA-512 integrity verified, bytes match the retained CI artifact,
  and the public tarball passed the unpacked artifact/installed SDK verifier again.
- APK: **kkcode-android-1.0.3.apk**, **52,754,774 bytes**; SHA-256
  `73a9c80d34b58770e54476cc1b69ea1e01680135754b5262e7b3d05f29481b13`.
- Certificate SHA-256 remains
  `cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`.
- `android-update.json`: 431 bytes; SHA-256
  `d5571a63a85224280c62c8584525d4f939226131841fe92e5c5ecdfef8c808bc`.
  APK/manifest GitHub asset digests match the local verified files. SHA256SUMS
  and a CycloneDX SBOM are also attached; no private signing files were uploaded.
- Published v1.0.1 and v1.0.2 tags remain at c04fcaf and a820086 respectively.

### Production deployment boundary

The local enterprise gateway was upgraded and tested. The public
`coding.internal.zzheng.cn` health/discovery check still reported **1.0.2**, with
no `authentication.nativeLogin` capability. No production SSH/CI deployment
channel was supplied and no production service was changed in this task.
The cloud operator must deploy v1.0.3 from this tag, preserving the existing
database/OIDC configuration. See [gateway login deployment](android-gateway-login.md).
Until then the updated App explicitly falls back to manual return; updating the
phone alone does not change the gateway's success page. The demo VM/CLI was not
restarted by this App/gateway patch.
