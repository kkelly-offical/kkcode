# Enterprise lab — local end-to-end acceptance

This is the current 1.0.1 development lab, not a production-release declaration.

## Deployed resources

- Compose project: `kkcode-enterprise-lab`, definition `deploy/lab/compose.yaml`.
- SSO: `https://10.0.0.2:18471` (Keycloak 26.6).
- Gateway/WebUI: `https://10.0.0.2:18472`.
- Both ports also bind 127.0.0.1 and redirect to the canonical WireGuard origin.
- Two dedicated PostgreSQL 17 containers/volumes; no database port published.
- Caddy terminates HTTPS with a lab CA. No global host CA trust was changed.
- Private runtime state and generated credentials are outside the repository in
  `/root/.local/share/kkcode-enterprise-lab/`, directory mode 0700.
  `credentials.json` and `lab.env` are private files. Do not print or commit them.
- `ca.crt` is public; private keys remain 0600. The gateway container can read the public CA.
- No existing project containers, databases, WireGuard configuration or VMs were altered.

## Reproducible commands

```sh
node scripts/setup-enterprise-lab.mjs
docker compose --env-file /root/.local/share/kkcode-enterprise-lab/lab.env -f deploy/lab/compose.yaml up -d --build
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  KKCODE_CHROMIUM=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  node scripts/lab-auth-smoke.mjs
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  KKCODE_CHROMIUM=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  node scripts/lab-enterprise-smoke.mjs
```

Only the dedicated lab is addressed by these Compose commands. Do not use `down -v`
unless intentionally deleting this lab's account/database data.

## Verified so far

- Real Keycloak PKCE login and signed ID-token validation against its JWKS.
- Real PostgreSQL persistence, organization roles, atomic refresh consumption,
  and isolated client logout. An administrator is not implicitly a device reader.
- Real CLI device login, `remote status`, registered outbound Relay, and
  `remote --web` sharing one DeviceService with a paired loopback WebUI.
- Terminal messages visible through loopback WebUI and WireGuard WebUI.
- SDK through the deployed gateway: OpenAI/Anthropic HTTPS model catalog discovery,
  hot configuration, model selection, request deduplication, real file mutation
  after approval in another browser, shared question answers, cancellation,
  `remote stop`, and foreground offline lifecycle.
- Explicit view/control sharing, immediate revocation, and administrator isolation
  were also exercised against the deployed PostgreSQL/Keycloak gateway.
- Native Android initiated its own device grant, completed real organization login,
  selected the registered computer, discovered Anthropic models, changed model and
  execution mode, and sent a message seen in both WebUI clients. This tests the
  native application state/transport; browser approval was automated in Chromium,
  not through the Android Chrome UI.
- Android verified the Linux QA VM's SSH host fingerprint, authenticated with a
  private key, started the installed 1.0.1 CLI Web service, paired over an SSH tunnel,
  listed its home directory and rejected access to `.ssh/authorized_keys`.
- Restarting only the lab gateway preserved database login/device ownership. The
  foreground terminal reconnected; SDK history and event-cursor replay continued.
- Direct WireGuard HTTPS Host mode passed one-time pairing, Secure cookies,
  hostile-Origin rejection, protected folders, compact WebUI and logout checks.
- Live Kimi Base URL catalog returned `kimi-for-coding`, `kimi-for-coding-highspeed`,
  `k3`, `k3-256k`; one bounded K3 inference returned the requested canary.
  Actual model credentials were not printed or sent to the gateway.
- Android debug/UI-test builds, 14 Compose UI tests, 14 JVM tests and three opt-in
  real-network tests passed. A separate project-signed release APK also passed
  certificate/v2/v3/non-debuggable verification and installation on its own AVD.
- The expanded Relay run sent real text and PNG bytes through both OpenAI and
  Anthropic adapters, verified canonical history retention after staging removal,
  exercised native Android branch create/switch-back, and verified that a
  persisted read-only permission rejects the next actual write.
- Actual CLI unbind revoked the retired UUID, sharing and device credentials;
  explicit `--include-history` transfer completed a second account's SSO login,
  rotated the device UUID, admitted the new owner and denied the previous owner.
  The final transferred foreground hub was stopped and became offline.
- Installed npm package: version 1.0.1 and the public kernel SDK, browser-safe SDK
  client and protocol exports all load outside the repository.
- Latest local Node suite: 2,597 tests / 2,596 passed / 1 skipped / 0 failed. Lint,
  kernel/Web typechecks, import-boundary/stdout checks, version policy and source
  secret scan passed. Installed package/SDK checks pass (456 packaged files).

Final artifact hashes and hosted Windows/macOS job results are recorded in the
implementation ledger after their corresponding checks finish. Local tarballs
are test artifacts, not npm publications or release tags.

The successful expanded run is
`/root/.local/share/kkcode-enterprise-runs/integration-lZtBuw`.
Its configuration, credentials and Android test fixture are in its protected
`.kkcode/` subdirectory; `workspace/` and screenshots contain only test material.
New runs use this sibling runs directory, not the lab's protected credential root.

The deterministic HTTPS provider in `scripts/lab-fixture-provider.mjs` is for repeatable
approval/cancellation tests; it is not shipped as a default model catalog or presented
as a real LLM. Browser automation bypasses only this lab's self-signed certificate
validation; Node/curl clients explicitly trust the generated CA, not all certificates.

## Running the expanded checks

```sh
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  KKCODE_CHROMIUM=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  ANDROID_HOME=/root/android-sdk KKCODE_ANDROID_SERIAL=emulator-5580 \
  KKCODE_LAB_RESTART_GATEWAY=1 node scripts/lab-enterprise-smoke.mjs
NODE_EXTRA_CA_CERTS=/root/.local/share/kkcode-enterprise-lab/ca.crt \
  KKCODE_CHROMIUM=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  node scripts/lab-host-smoke.mjs
ANDROID_HOME=/root/android-sdk KKCODE_ANDROID_SERIAL=emulator-5580 \
  node scripts/android-ui-smoke.mjs
```

The optional enterprise flags explicitly target this lab gateway and dedicated
emulator/QA VM. The restart flag intentionally interrupts this lab's gateway.
Run these tests serially: each uses its own private state but the companion local
WebUI test port is 18476. Fixtures with private credentials stay outside Git;
temporary copies pushed into the Android app are removed after each run.

The emulator originally inherited the host's `http_proxy`, which caused TLS EOF
failures. Restarting **only this test AVD** without proxy environment variables
fixed the transport. Certificate checking remains enabled. Do not blindly change
the user's global proxy or trust settings.

## Completed development and deployment responsibilities

Replay/request limits, device and canonical-history cross-process locking,
unbinding/explicit transfer, child approvals (including worker IPC), command
parity, attachments and safe Git branches are implemented and tested. Gateway
multi-replica routing, actual PostgreSQL failover/recovery drills, encrypted
backup/restore and real Keycloak/Dex login are documented in
`enterprise-ha-recovery.md`; the persistent two-port demo intentionally remains
single-gateway, while the HA fault-injection lab uses separate temporary nodes.

Hosted Windows/macOS acceptance is tracked on the dedicated acceptance branch.
The first runs uncovered a case-insensitive Web import collision, Windows
submodule path comparison and child-process termination issues; fixes have their
own regression tests rather than platform skips. Refer to the final CI result,
not a Linux pass, for platform acceptance.

Production DNS/TLS, database infrastructure HA, external SSO tenant provisioning,
off-machine backup/key custody and physical-device/store review remain deployment
responsibilities. No claim is made that these external environments were supplied.

The lab CA was added only to the dedicated `kkcode_101_api36` emulator user trust store.
Android debug builds allow user-installed CAs; release builds keep normal system trust.
The Linux QA VM remains `kkcode-101-linux` at `192.168.122.8` (SSH user `qa`).
The signed-release Android AVD is separate: `kkcode_101_release_api36`, port 5582.

Lab services remain running for inspection. The test foreground controller was
stopped deliberately and its device is offline; no unattended remote execution hub
was left behind. See `enterprise-deployment.md` for component ownership and startup.
