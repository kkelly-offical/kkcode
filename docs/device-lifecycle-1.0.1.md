# Device ownership, unbind and account transfer (1.0.1)

Remote ownership is per OS-user KK Code state directory. First binding assigns that local history to the chosen SSO account. Signing into a different account or gateway never silently transfers an existing binding or retained history.

## Unbind a computer

Run these commands on the controlled computer, not in a Web/Android chat:

```sh
kkcode remote stop
kkcode remote status
kkcode remote unbind --confirm DEVICE_ID_FROM_STATUS
```

In an interactive terminal, omitting `--confirm` asks you to type the device ID. In scripts, the exact ID is mandatory. A running foreground hub must stop before login, logout, unbind or transfer changes its identity. The local state is additionally protected by a process-lifetime lock shared with standalone WebUI device services.

`remote stop` uses a private token-authenticated Unix socket (Windows: named pipe), not a signal sent to a PID read from a status file. Stale PID reuse cannot accidentally stop an unrelated process. The status command never prints the private control token.

Unbind does the following in order:

1. Writes a private local pending-revocation marker. Remote startup is blocked while this marker exists.
2. Asks the gateway to retire the old device UUID permanently. The gateway immediately blocks that UUID, closes its relay connection, revokes **all device login sessions bound to it**, and removes its sharing grants and device-index entry. Other browser/app logins belonging to the account are not globally logged out.
3. Rotates the local UUID, clears the local remote credential, and removes the pending marker only after the gateway confirms success.

Conversations, workspace files and model settings are **not deleted**. They remain local; the previous owner is recorded as the retained-history owner. The old UUID cannot be registered again, even using a newly issued login. A newly bound device starts with no copied sharing grants.

Unbind requires a same-owner SSO-authorized **device** login. Browser/client tokens and organization-administrator status do not grant this authority. A freshly reauthenticated same-owner device login may revoke an old device without briefly re-exposing its old shares; a login already bound to a different device is rejected. This is explicitly owner-management authorization, not cryptographic proof of physical presence.

## Transfer to another account or gateway

```sh
kkcode remote transfer --gateway https://gateway.example.org \
  --confirm DEVICE_ID_FROM_STATUS --include-history
kkcode remote
```

`--include-history` is required. It explicitly consents to the new account accessing the computer's retained conversations, allowed folders and model configuration. The old binding is fully revoked before the browser asks for the new SSO account. The new owner is then recorded locally; the new device becomes online when `kkcode remote` starts. Old session shares are never copied.

Model credentials stay on the controlled computer, but the new owner can use its configured models. If that is not intended, use a different OS account with separate configuration and a suitably restricted `--root`. Merely choosing a new `KKCODE_HOME` does **not** isolate the filesystem: the default folder root is still the OS user's home.

Web and Android deliberately do not offer a one-tap account transfer. Their management sheets direct the owner to these local commands. Client logout only disconnects that client's login; it is not device unbinding.

## Interrupted-operation recovery

- Gateway unreachable: unbind returns an error and keeps the old local binding plus the pending marker. It does not pretend to have revoked a remote credential. Restore connectivity, then repeat `remote unbind` with the old device ID shown in `remote status`.
- Gateway completed revocation but its response was lost: the same retired bearer may replay **only that exact confirmed unbind**, through a hashed receipt retained for up to 24 hours. No raw token is stored in the receipt.
- Receipt expired or credentials were lost: use `remote login` with the **previous owner account**, then repeat unbind. The gateway's tombstone permits same-owner recovery without resurrecting the old device.
- Local failure after the gateway response: the durable `revoked` phase finishes UUID rotation and credential cleanup without repeating gateway mutations.
- Transfer login cancelled: the old device remains revoked and the retained history remains protected by its ownership marker. Repeat `remote transfer`, using the current ID from `remote status`, to explicitly consent and select the intended account.
- Never delete an identity/pending file to bypass a failed unbind. That would discard the evidence needed for safe recovery, without proving that a remote token was revoked.

## Automated acceptance

`node --test test/device-lifecycle.test.mjs test/remote-local-control.test.mjs` covers owner/admin/client isolation, unrelated-device credentials, confirmation, share and token revocation, lost-response replay, partial-server cleanup recovery, offline fail-closed behavior, UUID rotation, retained-history consent, gateway changes, post-rotation cleanup failure, lifecycle process exclusion, corrupt identity files, authenticated stop, forged status data and occupied/unrelated IPC paths. Relay/gateway integration separately exercises authenticated transport and device registration.

The gateway persists only identity/binding metadata, revocation receipts and audit metadata here. It does not persist conversation contents, model credentials or filesystem data for this operation.
