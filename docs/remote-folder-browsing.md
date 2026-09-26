# Remote folder browsing and workspace trust

[Documentation](README.md) · Source target: 1.1.6; see [release status](versions.md).

Remote clients browse the controlled computer through `folders.list` and
`files.read`. The browsing scope is explicitly authorized on the controlled
computer. Interactive `kkcode remote` asks whether to allow all ordinary local
folders accessible to the current OS user. Accepting opens the local filesystem
(Windows: local volumes, not network drives); declining or pressing Enter opens
only the user's home. Browsing always starts at home when it is in scope, not
the terminal's startup directory.

Non-interactive starts must choose `--all-folders`, `--home-only` or
`--root <path>` explicitly; these options are mutually exclusive. `--trust`
does not imply directory consent. The prompt occurs before SSO login, so an
unattended command without a scope fails immediately with actionable guidance.
This consent is per remote startup, not an implicit permanent machine-wide
grant. `remote status` displays `folderAccess` and the actual roots.

## Explicit recursive workspace trust

Recursive workspace trust first shipped in 1.0.2 and remains available in the
current source. It is not an unreleased demo-only patch and is never enabled implicitly.

Browsing permission and project trust are separate. `--all-folders` permits
remote navigation, but does not authorize project-defined provider endpoints,
credential sources, hooks or extensions. The existing `--trust` trusts only the
startup workspace. To explicitly trust all workspaces under a reviewed root:

```sh
kkcode remote --gateway https://your-gateway.example \
  --root /srv/projects --trust-all-workspaces
```

For a dedicated, operator-approved computer, `--all-folders` can replace
`--root /srv/projects`. This is a broad authorization: existing and future
projects under those roots may supply configuration and executable extensions.
Do not enable it for trees containing projects you do not trust. It remains
disabled by default, and cannot be enabled by project configuration.

Recursive grants persist in the local OS user's private trust store; omitting
the flag on a later startup does not revoke them. Folder exposure still ends
with the foreground remote process and still requires consent on the next
startup. `/untrust` in a child workspace overrides inherited trust there.
Revoking the granted root removes inheritance from that root, while separately
granted child workspaces remain trusted. Physical paths determine inheritance,
so symlinks out of a narrower trusted tree do not widen it.

`remote status` reports `startupWorkspaceTrustRoots`, the minimal physical roots
explicitly granted by this startup. It is not an inventory of every previously
saved trust decision. Neither trust flag changes OS permissions, tool approvals
or private-path browsing protections. Read-only OS directories may still be
unsuitable as a working directory when the agent needs to write project state.

The same trust-source handling also avoids treating the user's own configuration file as
a project override when the working directory is the user's home. Separate
project files still go through the normal provider-source trust checks.

## Roots and navigation

- `status` returns `roots` (absolute paths). Calling `folders.list` with no
  `path` opens the first reachable root — by default the home directory.
- `folders.list` responses carry `parent`: the absolute parent path when it
  stays inside an allowed root, otherwise `null`. Clients walk up until
  `parent` is `null` instead of string-trimming paths into a `path_denied`
  error at the boundary.
- Entries that are inaccessible or protected are skipped, not listed with an
  error, so one bad child never breaks a listing.
- `sessions.create`, branch operations and other cwd-taking RPCs accept any
  directory inside the same roots.

## Protection

Credential and private-state paths are still denied with `path_denied`
(`.ssh`, `.aws`, `.gnupg`, `.config`, `.env*`, `*.pem`/`*.key`/keystores, the
KK Code private state root, signing/lab state directories), enforced by path
component, realpath and inode identity checks — symlink/case-alias escapes do
not bypass them. Merely changing `KKCODE_HOME` never widens the filesystem
scope; see docs/device-lifecycle-1.0.1.md.

All-folder consent never elevates OS privileges or bypasses tool approval.
Unix process/device/runtime trees (`/proc`, `/sys`, `/dev`, `/run`, `/var/run`)
and system credential stores such as `/etc/ssh`, `/etc/ssl/private` and shadow
password files remain private. This protects environment credentials and sockets
that would otherwise become browsable through `/`. Permission errors identify
whether a path needs consent, is private, is missing or is inaccessible to the
current OS user; no raw “Path is outside the allowed device folders” message.

## Tolerance error codes

- `path_denied` (403) — outside the allowed roots or a protected path.
- `path_missing` (404) — inside the roots but does not exist.
- `folder_unreadable` (403) — exists but cannot be listed.
- `not_directory` (400) — a file was passed where a folder is required.

A configured root that is missing or unreachable no longer poisons the other
roots: paths under it simply resolve as `path_missing` while the remaining
roots keep working.

## Tests

`test/device-folders-browsing.test.mjs` covers home-wide reachability from a
deep terminal cwd, the default-root contract, `parent` navigation to the
boundary, credential-folder exclusion and the tolerance codes.
`test/device-path-security.test.mjs` keeps the adversarial coverage (symlink
and case-alias escapes, UNC paths, protected private state).
`test/remote-folder-access.test.mjs` covers yes/no consent, explicit unattended
flags, conflicting options, local roots and private Unix paths even under `/`.
`test/workspace-recursive-trust.test.mjs` covers opt-in root validation, exact
versus inherited trust, revocation, future folders, realpath escapes and actual
device kernels. `test/config-source-identity.test.mjs` covers user/project file
identity, aliases and distinct project overrides.
