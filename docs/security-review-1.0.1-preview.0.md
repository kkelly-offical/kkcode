# Preview publication security review

Reviewed on 2026-09-22, before publishing `1.0.1-preview.0`. This is a scoped
engineering review, not a claim of zero vulnerabilities or external certification.

The initial preview commit `b5d7f46` passed functional CI, but the main CodeQL
analysis reported 20 open findings (#17–36). A successful analysis job means the
scanner ran; it does **not** mean its findings were resolved. Publication was held
while the findings were traced and tested. No scanner rule was disabled, no
finding was dismissed through the API, and no analysis exclusion was added.

## Confirmed issues and hardening

| Findings | Resolution |
| --- | --- |
| #36, lab Dex proxy request forgery | The WireGuard lab-only HTTPS proxy accepted an absolute request target via `new URL(req.url, backend)`, which could change the upstream authority. The helper now connects only to literal `127.0.0.1` and the startup-time port. Incoming data is passed only as an origin-form `path`; absolute/network-path, control characters and malformed encodings are rejected. Production gateway routing did not use this helper. |
| #22–24, provider URL ReDoS | Repeated slashes followed by a non-slash could trigger quadratic backtracking in suffix replacement. Provider trust checks, routing, catalog resolution and wizard matching now use a linear suffix scan. The equivalent updater normalization was also hardened. |
| #26, device path resolution | Resolve allowed roots first, reject paths outside their lexical scope before resolving user-selected paths, and still enforce canonical containment afterward. This avoids outside-path existence probes and unapproved Windows UNC resolution. Protected state/signing/lab roots are additionally checked by physical directory identity, and file-preview identity comparisons use BigInt inode/device values. |
| #25, attachment deletion | The existing server-generated UUID/record-map boundary already prevented arbitrary path removal. Deletion now also explicitly validates the UUID and constructs the filename from the validated stored record. |
| #27–29, replay reads | Session IDs already have a strict filename-stem allowlist. An additional local-integrity review covers preplanted links and file replacement; replay I/O is hardened separately from the remote traversal finding. This does not claim that the application isolates an attacker who already controls the same OS account. |

The lab proxy test runs real backend, trap and proxy HTTP listeners; malicious
targets never reach either backend, normal callback/query/POST data survives, and
an incoming Host header cannot redirect the socket. Provider and wizard tests
exercise 400,000 slashes inside independently terminable workers, including
relative endpoint, trust-source and model-catalog behavior.
The real Dex 2.44.0 + PostgreSQL WireGuard-HTTPS acceptance was rerun after the
proxy fix and passed PKCE/JWKS login, groups scope, HttpOnly grant exchange,
refresh and logout. Its owned temporary resources were cleaned up; the persistent
Keycloak/gateway lab was not replaced or deleted.

## Findings whose reported exploit is blocked or not applicable

| Findings | Evidence and boundary |
| --- | --- |
| #30, canonical session path | SARIF analysis `1812392639` traces the authenticated RPC session ID to `sessionDataPath`. Before filesystem access, that helper checks type, a 1–128-character ASCII allowlist and reserved prototype names, then joins a fixed local state directory. Separators, encoded traversal, UNC/drive strings and control characters are rejected. |
| #31–35, generic private-file writer | The traced callers are replay `file()`/`meta()` paths; both validate session IDs before constructing fixed-root filenames. A raw RPC parameter cannot select the writer's root or arbitrary target. Exclusive temporary creation plus atomic rename replaces a leaf link rather than modifying its external target. |
| #27–29, remote replay traversal | `ReplayStore.file()` validates the ID; `meta()` calls the same guard. Tests through the real authenticated HTTP endpoint prove malicious IDs cannot escape state, including when local index metadata is deliberately poisoned. Local planted-link integrity is a separate precondition addressed above. |
| #20–21, API-key SHA-256 | This is the model-catalog cache namespace, not a password verifier. Cache values contain only `{fetchedAt, models}`; authentication/trust checks precede lookup. Tests prove different credentials use separate catalog entries and raw keys are not stored in the cache. Replacing this with a password KDF would not fix an authentication boundary. |
| #19, file-mention escaping | The formatter feeds the custom `readToken` grammar, not a shell. Only backslash-space is decoded; other backslashes remain literal. Added round trips cover existing backslashes, quotes and shell metacharacters. The result must never be repurposed as shell quoting. |
| #17–18, test-only string operations | These operated on fixed test strings/ANSI prefixes, not HTML or untrusted escaping. Assertions now compare the actual color prefix and use the constant ESC byte directly, removing misleading sanitizer-shaped code without reducing test coverage. |

`test/codeql-session-path-guards.test.mjs` tests both direct storage and the actual
paired HTTP boundary. Its cases include slash/backslash traversal, double encoding,
UNC/drive forms, NUL, CR/LF, Unicode line separators/lookalike slashes, non-string
values and overlong IDs. It verifies that valid expired replay rewrites remain
inside private state and atomic writes do not modify external linked targets.

A same-user attacker who can already write the private state directory or replace
process environment variables is outside the remote-RPC authorization boundary.
In particular, canonical history reading is not advertised as a sandbox against
arbitrary same-user preplanted state. Normal private-directory permissions, OS
account separation and trusted backup handling remain necessary.

## Release interpretation

The follow-up commit must pass functional checks and a fresh CodeQL analysis
before publication. Some generic path/credential-cache findings may remain open
when CodeQL cannot model these project-specific guards; their scoped disposition
is recorded here rather than hidden by blanket suppression. New or materially
changed findings still require review.

The production npm dependency audit at preparation time reported zero advisories.
That audit does not cover Android dependencies, container OS packages, deployed
SSO tenant policy or an enterprise's infrastructure. Release signing likewise does
not replace physical-device testing, operational security review or key backup.
