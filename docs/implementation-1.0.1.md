# 1.0.1 implementation ledger

Status: agreed 1.0.1 implementation and scoped acceptance completed; not released. Baseline: v1.0.0 / 21342dd.

## Accepted scope

1. Safety/recovery: config redaction, isolated tests, named checkpoints, mutation snapshots, resource cleanup.
2. Instance-scoped kernel, public SDK and versioned device API with event replay and request deduplication.
3. MCP, Agent Skills, tool schemas and portable plugin lifecycle.
4. Bundled responsive WebUI; loopback and authenticated Host on port 18271.
5. Foreground Relay with OIDC SSO, private devices, explicit sharing and concurrent-client control.
6. Native Android client with Relay and SSH connections.
7. Linux/Windows/macOS/Android validation, packaging and deployment documentation.

## Release policy

Only 1.0.x until explicit user authorization. Keep stable CLI JSONL compatible.
Release candidate requires the CLI package, gateway image, installable APK,
protocol/SDK documentation, migration notes and verified cross-platform results.

## Validation log

### Current implementation (not a release declaration)

- Kernel runtime context, instance provider/event routing and public SDK/device protocol scaffolding are present. A concurrent real-turn test verifies cwd/provider/event separation and independent shutdown.
- Local/Host server, pairing, request deduplication, leases, protected folder browsing and session/turn APIs are present. Host requires TLS or an HTTPS reverse proxy.
- Gateway/OIDC device login and outbound foreground Relay are implemented. A real Keycloak + two PostgreSQL databases + HTTPS gateway deployment passes local/WireGuard integration checks. The actual enterprise's infrastructure, tenant configuration and operational acceptance remain deployment-specific responsibilities.
- WebUI is bundled into the CLI. Native Kotlin/Compose Android has Relay and SSH clients plus an authorized project release-signing identity; signed APK signature/version/non-debuggable and isolated installation checks have passed.
- UI steering has been implemented in both clients: compact home, hidden configuration forms, layered settings, compact tool rows, expandable red/green diffs, folded thinking and contextual command suggestions. See `mobile-ui-1.0.1.md`.
- Config redaction, named checkpoint recovery, metadata-only skills, JSON Schema drafts 07/2019-09/2020-12, official SDK stdio/Streamable HTTP MCP and portable plugin lifecycle have a 45-case compatibility acceptance suite. See `protocol-compatibility-1.0.1.md` for precise supported contracts and nonclaims.

### Executed checks

- Final local Node suite: 2,600 tests, 2,599 passed, 1 macOS-only test skipped on Linux, 0 failed (37.6 seconds). Hosted platform results are recorded separately below; operating-system-specific skips are not counted as passes.
- `npm run lint`, kernel typecheck, Web TypeScript typecheck and the 1.0.x version policy check: passed.
- Web browser smoke: passed at desktop, 390px mobile and 320px narrow widths. Includes an actual kernel/device turn with a test provider, no configuration on startup, settings navigation, focus/Escape, search, command completion, tool/thinking folding, Markdown and diff rendering.
- Android debug/instrumentation builds passed. Fourteen Compose UI tests, fourteen JVM tests and three opt-in real-network tests passed: native device-grant state flow, model/mode/session synchronization, document upload/removal, safe branch creation/switch-back, HTTPS Relay and host-verified SSH to the Linux VM. Browser login approval was automated in host Chromium, not through the Android Chrome UI.
- Real Keycloak PKCE/JWKS login, organization roles, single-use refresh and independent logout passed. Deployed gateway checks also covered private/admin isolation, sharing/revocation, cross-client approvals/questions, cancellation, foreground stop/offline and gateway restart recovery.
- Both model-list protocol adapters passed against a controlled HTTPS provider. Separately, a real configured Kimi channel returned its catalog and completed one bounded K3 inference. No claim is made that live OpenAI or Anthropic paid accounts were tested.
- Installed npm smoke passed, including public SDK/kernel/client/protocol imports and packaged secret scanning. The immutable 1.0.1 tarball passed verification (456 files, SHA-256 `b8c45cbc09e03377ff92f8509d79768abd348eccf26b6bbf240578d556f63588`) and was installed in the dedicated Linux QA VM with Node 22.23.2. Details and exact lab commands are in `enterprise-lab-progress.md`.
- A separate Linux QA VM and debug/release Android emulators were created. Existing Windows/project VMs were not modified. Windows/macOS acceptance uses the authorized real GitHub-hosted operating systems, not Linux emulation; see the hosted matrix below.
- The final local enterprise run, `/root/.local/share/kkcode-enterprise-runs/integration-yD0Dtj`, passed every deployed CLI/SDK/Web/Android check, including gateway restart, actual unbind and explicit account/history transfer. SSO and gateway health checks passed after the run; its foreground controller was stopped deliberately.

### Gateway HA / SSO / recovery acceptance (2026-09-21)

- Optional multi-gateway routing now uses PostgreSQL route leases and fencing IDs, transient AES-GCM-authenticated node RPC, heartbeat/liveness checks, bounded in-flight queues and fail-closed revocation. No RPC body is persisted. `deploy/compose.ha.yaml` and `deploy/Caddyfile.ha` both pass configuration validation.
- `scripts/lab-ha-smoke.mjs` passed with two independent gateway processes and a real isolated PostgreSQL database: cross-node routing, SIGKILL failover, device reconnect, restarted-node routing, cross-node atomic refresh and revocation. Only acceptance processes/database were removed; the deployed Keycloak lab was unchanged.
- `scripts/lab-dex-smoke.mjs` passed with a real Dex 2.44.0 container, WireGuard HTTPS and isolated PostgreSQL gateway database: PKCE/JWKS login, configurable groups scope, HttpOnly browser grant completion, refresh and logout. This complements the existing Keycloak acceptance; no claim is made about actual Entra/Okta tenant access.
- `scripts/lab-database-drill.mjs` passed for both live lab databases: encrypted PostgreSQL custom-format backup, integrity verification, restore into new isolated databases, and key-table checks (822 gateway metadata records / 4 Keycloak users in that snapshot). Only the temporary restore databases were deleted; encrypted backups remain outside Git.
- The focused gateway/identity/concurrency suite passes 21 tests, including 4 MiB upload and history envelopes, cross-node replay rejection, owner-only attachment/branch/profile ACLs, organization isolation, prototype-key rejection, unbind-vs-registration/sharing races, invalid-token rate-limit bypass prevention, readiness, backpressure and sanitized/retryable PostgreSQL errors. Focused ESLint passes.
- Metadata expiry and configurable audit retention (default 90 days / 100,000 records) are implemented. Permanent device tombstones remain to prevent retired UUID resurrection. Database host-level HA, offsite backup custody and enterprise RPO/RTO are deployment responsibilities, not simulated guarantees. See `enterprise-ha-recovery.md`.

### Remaining-feature implementation and acceptance

- Device unbind/history transfer: implemented and verified through actual CLI + Keycloak; old identity/share/refresh rejected, new owner admitted, previous owner denied. See `device-lifecycle-1.0.1.md`.
- Commands/approvals: 41 canonical commands / 54 names, transport actions, parent-routed child approvals, private worker IPC and cancellation. Actual kernel/DeviceService/file mutation tests accompany the routing matrix. See `remote-command-contract.md`.
- Attachments/Git: actual browser and Android upload and clean-repository branch creation/switching passed; both wire adapters received real attachment bytes; dirty/stale/worktree states are refused.
- Retention/concurrency: bounded replay/response/live preview, paginated history, atomic snapshot cursors, request deduplication and lifetime device locks implemented. An independently reproduced multiprocess canonical-history overwrite was fixed with transaction locks and operation merging. See `device-retention.md`.
- Gateway HA/recovery/SSO: two actual gateway processes with shared PostgreSQL, gateway-process failover and database-connection recovery, encrypted backup/isolated restore, real Keycloak and Dex login passed. This is not a PostgreSQL primary/replica failover claim. See `enterprise-ha-recovery.md`.
- Android signing: authorized project RSA4096 identity exists outside Git; formal APK verified and installed on a dedicated release AVD. UI 14/14 and JVM 14/14 passed; expanded three real-network tests passed. See `android-release.md`.
- The user authorized a dedicated acceptance branch and hosted Windows/macOS CI, **not** a main-branch update or a version publication. All four hosted matrix jobs completed successfully, as recorded below.

No npm publish, GitHub Release, release tag or application-store upload is authorized or performed by this acceptance work. Off-machine backups, production DNS/TLS, PostgreSQL infrastructure HA and third-party tenant provisioning remain deployment-operator responsibilities, not features silently claimed as supplied by the application.

### Final hosted acceptance matrix

All four jobs in [enterprise acceptance run 35621382694](https://github.com/kkelly-offical/kkcode/actions/runs/35621382694) completed successfully on 2026-09-21. Tested code: `ba35f70a303a2b4fd4332e3151b75390fdadfc77`, on `acceptance/1.0.1-enterprise-20260921`. The closeout commit after this code revision changes only acceptance documentation and deliberately does not rerun the unchanged executable code. `main` remains at `21342dd`.

| Hosted platform | Core tests (2,600 total) | Separate E2E tests | Installed SDK + both Web checks |
| --- | --- | --- | --- |
| Ubuntu / Node 22 | 2,594 passed / 6 skipped / 0 failed | 33 passed / 0 failed | Passed |
| Ubuntu / Node 24 | 2,594 passed / 6 skipped / 0 failed | 33 passed / 0 failed | Passed |
| macOS / Node 22 | 2,594 passed / 6 skipped / 0 failed | 32 passed / 1 skipped / 0 failed | Passed |
| Windows / Node 22 | 2,586 passed / 14 skipped / 0 failed | 32 passed / 1 skipped / 0 failed | Passed |

The workflow also runs version checks, lint, cycle/import checks, kernel/Web types, Web build, secret scanning, coverage and immutable installed-package smoke. The two Web checks use Chromium and the actual DeviceService, then exercise the remote UI contract.

Skip boundaries: hosted Linux lacks bubblewrap and cannot run macOS sandbox-exec; local Linux separately passed the bubblewrap cases. macOS cannot run Linux bubblewrap/PTY cases. Windows skips Unix sockets, POSIX permission/special-filename behavior, Linux/macOS sandbox and Linux PTY cases. These are explicit platform boundaries, not silent passes. All five native Windows shell regressions executed and passed, including timeout-driven descendant termination; macOS sandbox-exec was actually exercised. Real hardware, every terminal emulator, physical Android devices and enterprise-specific SSO tenants are not implied by this matrix.

Earlier matrix failures led to fixes for case-insensitive Web module resolution, Windows Git directory identity and dirty submodules, native process-tree cleanup, portable acceptance fixtures, pending store-flush cleanup races and Windows verification argv preservation. Regression tests remain enabled.

### Verified local artifacts

- CLI tarball: `/tmp/kkcode-101-b3b8777-KSpaXr/kkelly-offical-kkcode-1.0.1.tgz`, version `1.0.1`, 456 files, 1,219,019 bytes. SHA-256: `b8c45cbc09e03377ff92f8509d79768abd348eccf26b6bbf240578d556f63588`. Runtime payload matches the final cross-platform fixes; subsequent verification-runner/documentation changes are not included in the npm payload.
- Android APK: `android/app/build/outputs/apk/release/app-release.apk`, application `cn.kkcode.remote`, version `1.0.1` / `10001`. SHA-256: `912cf86e84dd44fd983de50215e48f68357965565ffa5fdd33f8c0a9b75f825d`. APK v2/v3, the project release certificate and non-debuggable manifest were verified; installation/compact-home launch passed on the separate release AVD.
- The public signing-certificate fingerprint and private-key backup procedure are in `android-release.md`. The signing identity is outside Git and has not been uploaded to CI. The project owner still needs encrypted off-machine custody before depending on this key for distributed updates.
- The persistent local gateway image was rebuilt from the final runtime source and used for the final enterprise rerun. Lab SSO remains at `https://10.0.0.2:18471`; gateway/WebUI remains at `https://10.0.0.2:18472`.
