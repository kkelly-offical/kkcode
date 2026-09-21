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
- Android debug and UI-test APK builds; seven Compose UI tests and three opt-in
  real-network tests passed on API 36. These are not release-signed artifacts.
- Installed npm package: version 1.0.1 and the public kernel SDK, browser-safe SDK
  client and protocol exports all load outside the repository.
- Final Node suite: 2,454 tests / 2,453 passed / 1 skipped / 0 failed. Lint,
  kernel/Web typechecks, import-boundary/stdout checks, version policy and source
  secret scan passed. Immutable packed artifact verification passed (440 files).

The validated development tarball is
`/tmp/kkcode-101-artifact-79IwpL/kkelly-offical-kkcode-1.0.1.tgz`, SHA-256
`ce6910917349798cac48f9f8c8731b0c7997cebd2f27c9b7ad7b85ae028df179`.
It is a local test artifact, not an npm publication or release tag.

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

## Remaining production/release work

- Long-running replay/request retention, cross-process device-state locking,
  explicit device ownership transfer/unbinding and a broader crash/recovery matrix.
- Terminal/remote subagent approval roll-up, complete slash-command parity,
  attachments and safe branch-selection workflows.
- Windows/macOS full-system and additional physical Android-device/browser coverage.
- Production domain/certificate provisioning, database backup/restore, other OIDC
  providers, release signing and deployment/load tests. This lab is not a HA setup.

The lab CA was added only to the dedicated `kkcode_101_api36` emulator user trust store.
Android debug builds allow user-installed CAs; release builds keep normal system trust.
The Linux QA VM remains `kkcode-101-linux` at `192.168.122.8` (SSH user `qa`).

Lab services remain running for inspection. The test foreground controller was
stopped deliberately and its device is offline; no unattended remote execution hub
was left behind. See `enterprise-deployment.md` for component ownership and startup.
