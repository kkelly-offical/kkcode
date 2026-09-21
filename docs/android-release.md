# Android 1.0.1-preview.1 release signing and acceptance

The Android application is a native remote client. Release signing is separate
from publishing: producing this APK does not upload it to a store or GitHub.

## Project signing identity

The user authorized creation of a project-specific production release key on
2026-09-21. It is not the Android debug key or an acceptance-only identity.

- Application ID: `cn.kkcode.remote`.
- Current prerelease version: `1.0.1-preview.1` / version code `10002`.
- Algorithm: RSA-4096, SHA256withRSA; certificate validity: 10,000 days.
- Public certificate SHA-256:
  `cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`.
- Private identity directory on the authorized build machine:
  `/root/.local/share/kkcode-signing/` (0700).
- `kkcode-release.p12`, `store-password`, and `signing.properties` are private
  0600 files outside Git. Do not print, attach, publish, or commit these files.
- `signing-public.json` contains only the public certificate fingerprint and
  non-secret provenance. It is safe to compare with APK verification output.

**Before relying on this identity for distributed updates, the project owner
must make an encrypted off-machine backup of the complete private directory.**
The passphrase file is required to recover the key. Losing the key can prevent
future APK updates; creating another key is not a transparent replacement.
The repository deliberately does not upload keys to any CI provider.

The previous `1.0.1` APKs were local, unpublished acceptance builds. The first
authorized public preview (`1.0.1-preview.0`) therefore retained version code
`10001`, and the second preview (`1.0.1-preview.1`) increments it to `10002`.
**Every subsequent publicly distributed Android update must increase
`versionCode`, including the eventual stable `1.0.1` and any later preview.**
Changing only `versionName` is not a valid public update policy. Keep using
the same signing identity unless an explicit, separately validated
key-rotation plan is adopted.

## Reproducible build and verification

Set `ANDROID_HOME` and provide Gradle 8.14.3 through `KKCODE_GRADLE` or `PATH`:

```sh
ANDROID_HOME=/path/to/android-sdk \
  KKCODE_GRADLE=/path/to/gradle \
  node scripts/android-release.mjs
```

The default external identity directory is
`$HOME/.local/share/kkcode-signing`; `KKCODE_ANDROID_SIGNING_DIR` can select an
existing secured copy. `--offline` is available after dependencies are cached.
`--verify-only` verifies an already built APK. `--init-key` is only for a newly
authorized signing identity: it refuses a nonempty directory and must not be
used to replace the established project certificate.

The script builds `android/app/build/outputs/apk/release/app-release.apk`, checks
APK v2/v3 signatures, compares the certificate to the saved project fingerprint,
checks package/version, and rejects a debuggable release. Its non-secret report
is `test-results/android-release-verification.json`. It does not echo signing
tool diagnostics, password contents, or private key material.

The build verifier and installed-package smoke test read the target from
`android/app/build.gradle.kts` and require `versionName` to match the root
`package.json` exactly. APK/installed version names and version codes are
compared exactly, so a stale stable APK cannot pass a preview check by prefix.
The application footer and Android User-Agent use `BuildConfig.VERSION_NAME`.

The signature verifier normally selects v3 for this app's minimum Android API
29. The script also verifies the v2 block with an explicit verifier API range;
that extra cryptographic check does not claim the app runs on Android API 24.
See the [official apksigner reference](https://developer.android.com/tools/apksigner).

Direct Gradle builds can use `KKCODE_ANDROID_SIGNING_PROPERTIES` pointing to an
external Java properties file with `storeFile`, `keyAlias`,
`storePasswordFile`, and `keyPasswordFile`. Equivalent environment variables:
`KKCODE_ANDROID_KEYSTORE`, `KKCODE_ANDROID_KEY_ALIAS`,
`KKCODE_ANDROID_STORE_PASSWORD_FILE`, `KKCODE_ANDROID_KEY_PASSWORD_FILE`.
Password variables contain **file paths**, not password values. A release build
without complete signing inputs fails; it never silently uses debug signing.

Release TLS validation uses the platform system trust store. User-installed lab
CAs are debug-only. Enterprises must use a publicly trusted certificate or
provision an organization CA through managed system trust; do not disable
certificate verification for deployment.

## Acceptance scope

- `ConversationUiTest`: compact startup and hidden settings, slash suggestions,
  real diff folding, question IDs/options, read-only sharing, attachment and
  branch actions, explicit branch confirmation, dirty-repository guard, child
  approval source, SSO/profile separation, and persisted appearance.
- `ComposerSelectorsTest`: composer mode/permission/model chips, shared-device
  hiding, permission picker immediate application, and model picker discovery
  source markers with manual entry as failure-only fallback.
- `ThemeTest`: dark/light schemes are pairwise distinct across background,
  surface, text, accent and semantic colors, and both keep readable contrast.
- `EventStreamTest`, `DeviceApiStreamTest`: SSE frame parsing (multi-line data,
  CRLF, keepalive comments, id persistence) and the event-stream transport
  (relay/direct paths, auth headers, cursor query, pre-stream JSON errors, and
  non-SSE fallback signaling).
- `ComposerPickersTest`: catalog source labels and the canonical approval set.
- `AttachmentInputTest`: exact-size bounded reading, unknown-size rejection,
  zero-byte provider reads, and protection against over-limit streams.
- `GatewayUrlTest`: HTTPS/WireGuard addresses, debug-only emulator cleartext,
  and rejection of credentials or misleading loopback prefixes in URLs.
- `ConversationStreamTest`: atomic snapshot prefix plus live tail, turn/step
  isolation, suppression of late journal deltas for canonical completed steps,
  partial continuations, final-response deduplication, preservation of earlier
  tool commentary, and thinking-duration restoration.
- `test/android-release-target.test.mjs`: root/Android version agreement,
  exact prerelease APK and installed-package checks, version-code/application
  identity validation, and rejection of debuggable artifacts.
- `EnterpriseNetworkTest`: explicit opt-in real Relay/OIDC and SSH tests. The
  native-login test also reads a uniquely owned MediaStore document through the
  actual ContentResolver, uploads/removes it, and uses remote slash commands.
  A `branchSessionId` fixture enables real native branch create/switch-back in a
  clean isolated Git repository. It never changes the KK Code source branch.
- Long histories expose a load-earlier action. Replay gaps reload a bounded
  snapshot and resume from its cursor; loading earlier pages does not reset
  the active event stream.

The signed release APK is tested separately from the debug APK because Android
correctly refuses an in-place update between different signing identities. The
dedicated release AVD is `kkcode_101_release_api36` on port 5582. The existing
debug AVD and its data are preserved. Release launch checks are not a substitute
for physical-device, accessibility, or store review.

```sh
ANDROID_HOME=/path/to/android-sdk KKCODE_ANDROID_SERIAL=emulator-5580 \
  node scripts/android-ui-smoke.mjs
ANDROID_HOME=/path/to/android-sdk KKCODE_ANDROID_SERIAL=emulator-5582 \
  node scripts/android-release-smoke.mjs
```

Validated locally: 21 Compose UI tests, 29 JVM tests, release
APK certificate/v2/v3/manifest checks, unsigned-release rejection, and a signed
release install/launch on the isolated API 36 AVD. Launch verification checks
the compact home, absence of configuration forms, a live process, and rejection
of `run-as` debugging. The screenshot is
`test-results/android-release-home.png`. Expanded enterprise network checks
must be run against the matching updated backend; their final result belongs
in `enterprise-lab-progress.md`, not inferred from these isolated UI checks.

## First preview artifact acceptance (2026-09-22)

For `1.0.1-preview.0` / `10001`, the six Node target-version tests and 14 release
JVM tests passed. The release was built with the existing project certificate,
then independently checked using `--verify-only`. The isolated 5582 AVD installed
the preview and passed the startup/non-debuggable checks. Debug AVD 5580 and its
data were not modified during preview packaging; the earlier Compose and real
network checks are recorded separately above and in the enterprise lab ledger.

- Artifact: `android/app/build/outputs/apk/release/app-release.apk`.
- APK SHA-256:
  `b24b0729f3094ec153c871b2b54edaf2d66bf2b446110a2e7de1797a5ee87260`.
- v2/v3 signatures valid; package/version match the root release target exactly;
  `debuggable=false`; existing certificate fingerprint unchanged.

## Second preview artifact acceptance (2026-09-22)

For `1.0.1-preview.1` / `10002`, the six Node target-version tests passed and
`scripts/android-release.mjs` built the signed release APK with the existing
project certificate. The script verified v2/v3 signatures, the exact
package/version/code match against the root release target, and a
non-debuggable manifest. The Compose/JVM suites and AVD install/launch checks
above cover the merged client code; a fresh install of this exact artifact on
the isolated 5582 AVD is recommended before the GitHub prerelease upload and
is not claimed here. The APK is a standby artifact: no upload or publishing
was performed.

- Artifact: `android/app/build/outputs/apk/release/app-release.apk`.
- APK SHA-256:
  `5f07c7313c4bd9b8035470ffb81adff4801cfc96881dfdd8507050f3fcb43d4d`.
- v2/v3 signatures valid; package `cn.kkcode.remote`, version
  `1.0.1-preview.1` / `10002` match the root release target exactly;
  `debuggable=false`; certificate fingerprint unchanged
  (`cf75774a4d87ba1ccc4a811f271bd301076cf6beefd7432a3cb30231164be5d1`).

This records artifact readiness only. Publishing/tagging/uploading the preview
is a separate authorized release operation, not an action performed by the
Android signing or smoke-test scripts.
