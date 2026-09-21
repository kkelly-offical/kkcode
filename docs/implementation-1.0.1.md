# 1.0.1 implementation ledger

Status: development; not released. Baseline: v1.0.0 / 21342dd.

## Accepted scope

1. Safety/recovery: config redaction, isolated tests, named checkpoints, mutation snapshots, resource cleanup.
2. Instance-scoped kernel, public SDK and versioned device API with event replay and request deduplication.
3. MCP, Agent Skills, tool schemas and portable plugin lifecycle.
4. Bundled responsive WebUI; loopback and authenticated Host on port 18271.
5. Foreground Relay with OIDC SSO, private devices, explicit sharing and concurrent-client control.
6. Native Android client with Relay and SSH connections.
7. Linux/Windows/Android validation, packaging and deployment documentation.

## Release policy

Only 1.0.x until explicit user authorization. Keep stable CLI JSONL compatible.
Release candidate requires the CLI package, gateway image, installable APK,
protocol/SDK documentation, migration notes and verified cross-platform results.

## Validation log

### Current implementation (not a release declaration)

- Kernel runtime context, instance provider/event routing and public SDK/device protocol scaffolding are present. A concurrent real-turn test verifies cwd/provider/event separation and independent shutdown.
- Local/Host server, pairing, request deduplication, leases, protected folder browsing and session/turn APIs are present. Host requires TLS or an HTTPS reverse proxy.
- Gateway/OIDC device login and outbound foreground Relay are implemented. A real Keycloak + two PostgreSQL databases + HTTPS gateway deployment now passes local/WireGuard integration checks. Production enterprise deployment is still a separate acceptance gate.
- WebUI is bundled into the CLI. Native Kotlin/Compose Android has Relay and SSH clients plus an authorized project release-signing identity; signed APK signature/version/non-debuggable and isolated installation checks have passed.
- UI steering has been implemented in both clients: compact home, hidden configuration forms, layered settings, compact tool rows, expandable red/green diffs, folded thinking and contextual command suggestions. See `mobile-ui-1.0.1.md`.
- Config redaction, named checkpoint recovery, metadata-only skills, JSON Schema drafts 07/2019-09/2020-12, official SDK stdio/Streamable HTTP MCP and portable plugin lifecycle have a 45-case compatibility acceptance suite. See `protocol-compatibility-1.0.1.md` for precise supported contracts and nonclaims.

### Executed checks

- Previous checkpoint: 2,454 Node tests, 2,453 passed, 1 skipped, 0 failed. The expanded final suite and hosted acceptance matrix are being rerun after the remaining-feature implementation; do not treat this historical count as the final one.
- `npm run lint`, kernel typecheck, Web TypeScript typecheck and the 1.0.x version policy check: passed.
- Web browser smoke: passed at desktop, 390px mobile and 320px narrow widths. Includes an actual kernel/device turn with a test provider, no configuration on startup, settings navigation, focus/Escape, search, command completion, tool/thinking folding, Markdown and diff rendering.
- Android debug/instrumentation builds passed. Seven Compose UI tests and three opt-in real-network tests passed: native device-grant state flow, model/mode/session synchronization, HTTPS Relay and host-verified SSH to the Linux VM.
- Real Keycloak PKCE/JWKS login, organization roles, single-use refresh and independent logout passed. Deployed gateway checks also covered private/admin isolation, sharing/revocation, cross-client approvals/questions, cancellation, foreground stop/offline and gateway restart recovery.
- Both model-list protocol adapters passed against a controlled HTTPS provider. Separately, a real configured Kimi channel returned its catalog and completed one bounded K3 inference. No claim is made that live OpenAI or Anthropic paid accounts were tested.
- Installed npm smoke passed, including public SDK/kernel/client/protocol imports and packaged secret scanning. The immutable 1.0.1 tarball passed verification (440 files, SHA-256 `ce6910917349798cac48f9f8c8731b0c7997cebd2f27c9b7ad7b85ae028df179`) and was installed in the dedicated Linux QA VM with Node 22.23.2. Details and exact lab commands are in `enterprise-lab-progress.md`.
- A separate Linux QA VM and Android emulator were created. Existing Windows/project VMs were not modified. Windows/macOS full-system validation has not been completed.

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
- Gateway HA/recovery/SSO: two actual gateway processes + PostgreSQL failover, encrypted backup/isolated restore, real Keycloak and Dex login passed. See `enterprise-ha-recovery.md`.
- Android signing: authorized project RSA4096 identity exists outside Git; formal APK verified and installed on a dedicated release AVD. UI 14/14 and JVM 14/14 passed; expanded three real-network tests passed. See `android-release.md`.
- The user authorized a dedicated acceptance branch and hosted Windows/macOS CI, **not** a main-branch update or a version publication. Hosted matrix results remain pending until the jobs actually finish.

No npm publish, GitHub Release, release tag or application-store upload is authorized or performed by this acceptance work. Off-machine backups, production DNS/TLS, PostgreSQL infrastructure HA and third-party tenant provisioning remain deployment-operator responsibilities, not features silently claimed as supplied by the application.
