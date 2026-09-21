# Remote SSE event contract (1.0.1)

Real-time server-sent events (SSE) for remote clients (WebUI, Android, terminal
status panels). SSE is additive: `events.list` polling, the WebSocket
`/api/v1/events` endpoint (device server), all RPC methods, request dedup
(`RequestLedger`, `id` + `issuedAt`) and the headless JSONL schema are
unchanged. `PROTOCOL_VERSION` stays `1`.

## Endpoints

| Surface | Endpoint | Kind |
| --- | --- | --- |
| Device server (paired / SSH tunnel) | `GET /api/v1/events/stream?sessionId=<id>[&after=<seq>]` | session stream (replayable) |
| Device server | `GET /api/v1/events/stream` | device stream (live only) |
| Gateway | `GET /api/v1/devices/:id/events/stream?sessionId=<id>[&after=<seq>]` | session stream (replayable) |
| Gateway | `GET /api/v1/devices/:id/events/stream` | device stream (live only) |

Authentication, Origin/Host checks and error envelopes are identical to the RPC
API on the same host (device: pairing cookie or `Authorization: Bearer`;
gateway: SSO cookie or Bearer). Errors before the stream starts are plain JSON
(`401 login_required`, `403 forbidden` — also for unknown device ids, mirroring
the RPC route, `410 device_unbound`, `503 device_offline` when a **session**
stream's device is offline). A device stream on an offline device opens
normally and reports `online: false` in its `connected` snapshot.

Authorization mirrors `events.list`: the device owner may open any stream; a
shared account must hold a grant (`view` or `control`) for the requested
`sessionId` (session stream) or any grant on the device (device stream, with
`session.status` events filtered to granted sessions). Revoking a share,
logging out, or unbinding the device closes the stream immediately; a login
session that expires naturally closes it on the next sync tick (the device
server closes streams at the moment of expiry).

## Framing

Standard `text/event-stream; charset=utf-8` with `Cache-Control: no-cache`:

```
retry: 2000

event: connected
id: 41
data: {"type":"connected",...}

event: stream.text.delta
id: 42
data: {"id":"...","sessionId":"...","seq":42,"timestamp":...,"schemaVersion":"1","type":"stream.text.delta","payload":{"text":"..."}}

: keepalive
```

- `id:` is the per-session journal cursor (`seq`, decimal integer) on session
  streams; on device streams it is a gateway-local monotonically increasing id
  that is **not** meaningful across reconnects. Control frames (`connected`,
  `replay.gap`, `session.state`) carry the last fully delivered cursor as
  their `id`, so a reconnect's `Last-Event-ID` never skips rows that were not
  yet delivered.
- `: keepalive` comments are sent at least every 15 seconds.
- `retry: 2000` is suggested once at connect; clients should honor it or use
  equivalent backoff.

## Session stream

The first frame is `event: connected`; its data mirrors the `events.list`
envelope so a client can boot from it:

```json
{"type":"connected","schemaVersion":"1","sessionId":"...","earliest":1,"cursor":41,
 "running":true,"control":{"yours":true,"until":...},"approvals":[],"pendingApprovalCount":0}
```

Every later journal row is delivered as `event: <row.type>` with
`id: <row.seq>` and the full row as `data` — the exact same object shape that
`events.list` returns inside `events[]` (`{id, sessionId, seq, timestamp,
schemaVersion, type, turnId?, payload}`). This covers assistant deltas
(`stream.text.delta`, `stream.thinking.delta`), tool call status (`tool.start`,
`tool.finish`, `tool.error`), turn state (`turn.start`, `turn.finish`,
`turn.result`, `turn.failed`), approvals (`approval.requested`,
`approval.resolved`) and configuration (`session.configured`,
`session.branch.changed`, `session.compacted`, …).

Reconnect with `Last-Event-ID: <seq>` (EventSource sends this automatically) or
`?after=<seq>`; the server replays journal rows with `seq > after` from the
same bounded replay journal behind `events.list`, then continues live. Dedup
rule for clients: ignore rows with `seq <= lastSeenSeq`. A typical bootstrap is
`sessions.get` → take `eventCursor` → open the stream with `after=eventCursor`
and render `liveEvents` until the stream takes over.

If the journal rotated past `after`, the server sends `event: replay.gap` with
`data: {"type":"replay.gap","earliest":<seq>,"cursor":<seq>}` and **keeps the
stream open**, continuing with available and live rows. The client must reload
the session snapshot via `sessions.get` — the same recovery as the existing
`gap` flag on `events.list`.

Whenever the envelope state (`running`, `control`, `pendingApprovalCount`)
changes, the stream emits `event: session.state`. The device server re-reads the
state after every delivered row; the gateway re-syncs authoritatively after
every turn-lifecycle (`turn.start`, `turn.finish`, `turn.result`, `turn.failed`)
and `approval.*` row, and on the periodic sync tick. Changes that produce no
journal row (`control.acquire` / `control.release`) surface on the next tick
(≤ 30 s in push mode, ~1 s in journal-sync fallback). The frame looks like:

```json
{"type":"session.state","sessionId":"...","running":false,
 "control":{"yours":false,"until":...},"pendingApprovalCount":1}
```

Approval request bodies are not repeated here; they arrive as
`approval.requested` rows. `session.state` never grants control.

Watching a session renews the caller's control lease exactly as polling
`events.list` does (on connect and on each sync tick, ≤ 30 s apart in push
mode). Acquiring/releasing control still requires `control.acquire` /
`control.release`.

Gateway session streams additionally pass through `device.online` /
`device.offline` notifications for the owning device so a conversation page can
show connectivity without opening a second stream.

## Device stream

Live-only status channel for device lists and terminal status panels. No
replay: `Last-Event-ID` is ignored and each connect starts with a fresh
snapshot, so reconnects are self-healing.

- `event: connected` → `{"type":"connected","schemaVersion":"1","deviceId":"...","online":true,"active":["sessionId",...]}`
- `event: device.online` / `event: device.offline` → `{"type":"device.online","deviceId":"...","timestamp":...}`
- `event: session.status` → `{"type":"session.status","deviceId":"...","sessionId":"...","running":true,"timestamp":...}` — derived from turn lifecycle rows and a status sync; carries no prompt or content.
- `event: settings.updated` → `{"type":"settings.updated","deviceId":"...","timestamp":...}` after a successful `settings.update`.
- `event: models.updated` → `{"type":"models.updated","deviceId":"...","provider":"<name>","source":"network|cache|config","stale":false,"models":[{"id":"...","origin":"auto|manual"},...],"timestamp":...}` when the discovered catalog for a provider changes (also emitted after `settings.updated` triggers re-discovery). `models` is capped (200 entries / 256 KiB); when capped, `truncated: true` is set and clients should call `models.discover`.

## Relay transport and version skew

Devices push journal rows over the existing relay WebSocket as
`{"type":"event","event":<row>}` and advertise `features:["events.push"]` in
their `register` message. Older gateways ignore unknown relay messages; older
devices simply never push. When push is unavailable (old device, or an HA
cluster route terminating on another gateway node), the gateway synchronizes
from the device journal with an internal `events.list` call about every 1 s
(and every 30 s as a drift/lease keepalive in push mode). The client-visible
SSE contract is identical in all modes; HA requires no new cluster protocol.

## Limits

- Device server: ≤ 8 open event streams (SSE + WebSocket) per paired client.
- Gateway: ≤ 16 open SSE streams per account and ≤ 64 per device.
- If a client falls more than 2 MiB behind, the server closes the stream;
  reconnecting with `Last-Event-ID` replays what was missed.
- SSE responses are read-only and never mutate device state; mutating RPCs keep
  the existing request-id dedup semantics.

## Per-session configuration over the same contract

Reading and switching the agent mode and permission level per session is part
of this contract surface:

- Read: `sessions.get` metadata includes `modeId`, `mode`, `approval`,
  `providerType`, `model`.
- Switch: `sessions.configure` accepts `mode`, `approval`, `provider`, `model`
  independently (mode `agent|plan|agent-auto|ultra|yolo`; approval
  `readonly|manual|accept-edits|yolo`) and records `session.configured`, which
  session streams deliver in real time to every attached client.

## Folder browsing additions (same release)

`folders.list` responses gain `parent` — the absolute parent path when it stays
inside an allowed root, otherwise `null`. Clients navigate upwards until
`parent` is `null` and call `folders.list` with no `path` for the home entry
(`roots[0]`; the default root is the OS user's home). New error codes:
`path_missing` (404, does not exist) and `folder_unreadable` (403, cannot be
listed). Credential/private-path protection (`path_denied`) is unchanged.
