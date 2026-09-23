# KK Code 1.0.2 Fix — implementation and acceptance

Technical version: **1.0.3**. Android public version code: **10006**.
Status: **implemented; final CI/artifact acceptance and publication pending**.

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
- An old gateway remains usable through manual App return and an explicit
  upgrade notice. No IdP callback registration or organization database reset
  is required. Production gateway deployment is separate from GitHub/npm.

## Receipts

- Focused Node run: **27 passed** (native return/security/SSO failure/legacy login).
- Local full release verification passed at the pre-SSO-error checkpoint:
  **2916 passed, 2 intentionally skipped, 0 failed**; line coverage **83.05%**;
  separate process E2E **33 passed**; lint/import boundaries/cycles/typechecks,
  secret scans, 518-file package scan and installed SDK/protocol smoke passed.
  CI must verify the final commit, including the additional SSO error test.
- Android JVM: **58 passed**; Compose/native lifecycle smoke: **33 passed**.
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
- The signed candidate passed v2/v3/existing-certificate/non-debuggable checks
  and in-place installation on the release AVD. Final APK rebuild and receipts
  follow the last error-handling change; earlier candidate hashes are not final.
- A browser integration test caught no-referrer turning Chrome form POSTs into
  Origin:null. Only completed pages now use no-referrer; form pages retain
  same-origin policy. The strict Origin boundary was not weakened.
- CI, final artifact verification and publication remain pending. Production
  cloud deployment is not implied by these local lab results.
