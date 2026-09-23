# Device replay, request deduplication and process ownership

These are transport/recovery limits in 1.0.1, not conversation deletion policies.
The canonical kernel conversation history is never deleted by these stores.

1.0.4 Preview adds an explicit, confirmed `sessions.delete` operation, separate
from transport retention. It rejects active work, removes the finished conversation
tree from the canonical index and replay, and retains a private JSON recovery copy
in `trash/sessions/`. Source files are not removed. These recovery copies are not
automatically purged and must be included in the owner's local capacity/backup policy;
there is no UI restore button or claim of secure erasure.

The new private `operations/` journal retains at most 256 settled records per
session and 32 unresolved outcomes. Unresolved entries are never silently rotated;
mutation is refused if the unresolved budget is exhausted. Records contain tool
identity and an argument fingerprint, not raw arguments. Inspect/acknowledge through
`kkcode session operations`; see [Harness recovery](context-and-harness.md).

In preview.2 the staging quotas also apply to WAV/MP3 audio and
MP4/MOV/WebM/MPEG video: 4 MiB per remote media file, at most eight attachments
per turn, 16 MiB per session and 64 MiB per device. CLI clipboard input has a
separate 20 MiB/file limit. See [media input](media-input.md). Device-scope
`mcp.loaded` summaries are live-only; they do not consume session replay storage.

## Event replay

- At most 2,000 retained events and 8 MiB per session.
- At most 64 MiB across all replay journals; oldest inactive journals are removed
  from replay first when quota is needed for the current session.
- Events older than 7 days are pruned on startup, append, or read.
- A stored event is limited to 512 KiB, including its newline. Oversized events
  become `replay.snapshot_required` markers. If a custom cap cannot fit the marker,
  the event is omitted while its sequence number is preserved.
- Each read returns at most 1,000 events and 4 MiB of event JSON. A byte-limited
  page is ordinary pagination: advance from its last event, not from the journal's
  high-water `cursor`.

Cursor files survive pruning and are published before each append. On a process
restart, cursor-only journals are recovered too. `gap: true` means the client
must reload the canonical session snapshot and resume from that snapshot's
cursor; it covers pruned events, malformed/missing events, snapshot markers and
out-of-range cursors. Sequence values are never reset merely because the replay
window is empty. These atomic filesystem operations do not promise recovery from
physical disk failure or an OS/power loss without durable storage.

## Request idempotency

- Default retention: 7 days, at most 10,000 records and 8 MiB of JSON.
- Completed results and classified protocol rejections receive a minimum
  15-minute retry window from completion, including under quota pressure.
- `running` records become `unknown` after a process restart. Neither `running`
  nor `unknown` records are automatically evicted. If they fill the journal, new
  mutations fail with `idempotency_capacity` until an operator inspects the
  uncertain outcomes; the server must not guess that an operation did not run.
- Results over 64 KiB, or results that would consume reserved failure-reporting
  space, are marked `omitted`. A retry must return `result_expired`, never execute
  the operation a second time.
- Protocol error codes/status and bounded messages are retained, so retries can
  reproduce a known rejection. Unexpected failures remain `unknown`.
- SDK requests carry `issuedAt`; the device rejects expired new mutation requests
  instead of replaying a request whose cache entry was already pruned. Legacy
  requests without `issuedAt` have **no duplicate-execution guarantee beyond the
  retained cache window**. Persist and reuse the original request ID and timestamp
  for application-managed retries.

Limits refer to logical JSON bytes. Filesystem allocation overhead and the tiny
per-session high-water files are additional. Atomic replacement briefly needs a
temporary copy; provision disk headroom. Old successful records are pruned lazily
on initialization and subsequent reservations.

## One device-state owner per process

The foreground device service owns a lifetime lock. The lock is a fully written
private inode published using an atomic hard link; no reader sees an empty
placeholder. NTFS, ordinary Linux filesystems and macOS filesystems support this
operation; unsupported/read-only filesystems fail closed rather than falling back
to an unsafe overwrite. Keep device state on a local filesystem, not a shared
network mount.

A live PID is never evicted due to age, and a lock from another host is never
assumed stale. Dead-owner recovery has a separate exclusive marker, preventing
two recovering processes from removing each other's newly acquired lock. Invalid
lock metadata or a recovery process that crashed leaving its marker requires
deliberate local inspection. Do not delete a lock or recovery marker until all
processes that may own that state have stopped. Normal shutdown removes only the
current owner's token-matching lock.

`test/device-retention.test.mjs` exercises quotas, time windows, cursor recovery,
oversized records and failures. `test/process-lock.test.mjs` starts independent
Node child processes to exercise simultaneous acquisition and dead-owner
recovery; the same tests are platform-neutral and should run in the Linux,
Windows and macOS validation jobs. A local Linux pass is not evidence that a
Windows or macOS job has executed successfully.
