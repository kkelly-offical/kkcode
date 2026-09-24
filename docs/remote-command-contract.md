# Remote command and approval contract

[Documentation](README.md) · Source target: 1.0.5; the device protocol remains version 1.

`commands.list` and the terminal completion menu derive their builtins from the
same registry. The catalog includes canonical builtins and aliases, plus the trusted workspace's custom commands and skills. Web/Android hide terminal-only `keys` and the legacy independent `permission` picker from suggestions; direct legacy invocation remains compatible.
Do not add a builtin without a `DEVICE_COMMAND_HANDLERS` entry and a matrix test.

## Dispatch

`commands.run` accepts `{sessionId, command}` while holding session control. It
does not open terminal readline prompts. Responses may contain `output`
(`{text,channel?,topic?,tone?}[]`), `panels` (`{title,text}[]`), updated `state`,
an accepted turn, or the following explicit client actions. Output text is
ANSI-free. A command error must be shown, not replaced by a success toast.

| Action | Required client behavior |
| --- | --- |
| `exit` | Disconnect this client, not the device's foreground hub |
| `clear` | Clear the visible transcript without deleting stored history |
| `keys` | Legacy invocation: transient note that terminal shortcuts are CLI-only, no shortcut panel |
| `theme` | Apply `args=dark/light/auto`, or show a picker |
| `paste` | Open working attachment selection; preserve `args` as draft text |
| `profile`, `like` | Open local preferences/onboarding, separately from SSO identity |
| `home` | Return to device/session home |
| `sessions` | Select an `items[{id,label,desc,cwd}]` session |
| `session` | Open `sessionId,cwd`; restore optional `draft` from `/rewind` |
| `models` | Show actual provider model catalog, with manual selection available |
| `provider` | Pick provider, add, or edit named provider according to `args` |
| `mode` | Choose `items[{id,label,desc}]`; invoke `/mode <id>` |
| `permission` | Legacy invocation redirects to the single execution-mode picker |

Provider/model/mode/approval changes persist through `sessions.configure` and
emit `session.configured`. `/new` copies the active selection to its new session.
Canonical modes are `plan`, `agent`, `auto`, `ultra`, `yolo`; `agent-auto` remains an input alias. Legacy `approval` input is conservatively mapped to one mode. Internal policy levels remain a compatibility/governance mechanism, not a second client selector.
`/plan <goal>` retains the terminal's read-only planning instructions. A rewritten
prompt is never interpreted a second time as a slash command. `/resume` refuses
ambiguous prefixes. `/undo` asks for confirmation with an explicit session ID;
`/rewind` changes history only, not files.

`profile.get` / `profile.update` edit the local model-facing profile, not the SSO
account. Update fields are `beginner`, `languages`, `tech_stack`, `design_style`
and `extra_notes`; unknown fields are rejected and writes use atomic mode 0600.

## Session, media and worktree RPCs

- `sessions.update`: owner-only `{sessionId,title?,expectedTitleRevision?,archived?}`; single-line bounded titles, atomic manual-title precedence, archive only while idle.
- `sessions.rewind`: session control plus `{confirmed:true,messageId?,expectedLastMessageId?}`; complete-turn history/parts transaction, private pre-rewind backup, draft return, no filesystem rollback. `session.rewound` invalidates old transcript/event caches on every client.
- `media.preview`: session-authorized `{sessionId,messageId,index}`; bounded raster data only, no arbitrary path or external URL reads. Session history transports `image_preview` references, never bulk image bytes.
- `branches.list`: detailed local branches and cached remote refs, guarded worktrees and state token. `branches.create` accepts an optional listed `startPoint`.
- `worktrees.list/create/open`: owner-only, explicit confirmation and fresh state token for mutations/opening. Creation needs `parent,folderName,name,startPoint?`; `open` needs `path` and creates a separate session, preserving the original cwd.
- `permission.review.started/finished`: compact live review status; `permission-review` parts retain completed decisions through canonical reload. Review outputs are advisory; deterministic security decisions remain authoritative.

These are additive protocol-v1 fields/methods; older devices do not implement them. Upgrade the device and gateway alongside the clients, rather than claiming client-only parity.

`/reload` reloads custom command files, skills and agent definitions using the
already loaded configuration; it is not a configuration-file watcher. `/mcp
reload` reconnects MCP separately. Model configuration changes use
`settings.update`, whose hot reload is managed by the device service.

## Child approvals

Session ancestry is stored in `parentSessionId`; IDs are opaque, bounded and
randomized so parallel delegates cannot collide within a millisecond. Recursive
turns inherit kernel dependencies but obtain their own prompt session identity.

The device projects an approval onto its top-level session. The request retains
`originSessionId`, `sourceSessionId`, immediate `parentSessionId`, `ancestry` and
`subagent` / `sourceLabel`. Clients answer using the public root `sessionId` and
the approval ID, never the child's session ID. This keeps session sharing and
authorization at the same root boundary. The first answer wins; later decisions
fail. Ancestor cancellation, originating prompt cancellation, device shutdown,
or timeout resolves a permission as deny and a question as empty.

Worker-process delegates use a private OS IPC pipe, not a listening port or a
credential file. Only the exact launching kernel/task holds the ephemeral
capability. The parent replaces every worker-supplied session/parent identity
with the recorded task identity. Background questions require explicit
`allow_question=true` and a live interactive parent; disconnected/headless
workers cannot obtain consent. Kernel shutdown cancels outstanding IPC prompts.
This does not terminate every detached background process: existing background
tasks may continue under already granted policy, but cannot obtain fresh human
approval through the closed parent. Foreground remote exposure still ends with
the hub. Unanswered IPC prompts resolve as deny/empty, never approval.

## Canonical session-store concurrency

The file-backed canonical session store uses a short-lived cross-process lock
for transactions, independent of the device journal's lifetime lock. Buffered
writes retain operations rather than replacing stale whole-index snapshots:
separate session creations, metadata patches, message/part additions and review
decisions merge against the latest on-disk state. Readers refresh between
transactions. History replacement removes only messages in its observed
baseline, preserving another process's later append. Fork creation is persisted
under one lock, and duplicate targets fail before data is overwritten.

Dirty buffers and timers are bound to their original storage root. Index/shard
writes are private atomic replacements; invalid IDs or damaged shards fail
closed. The configured data-flush debounce remains: process termination before
flush can still lose that process's uncommitted buffer. `flushNow` / normal
kernel shutdown are durability barriers; SIGKILL is not a successful commit.

## Tests and evidence

- `test/device-command-parity.test.mjs`: exhaustive canonical/alias routing,
  selector payloads, modes, custom expansion, profile validation, per-kernel
  permission cache, ancestry validation and late-answer cancellation. The
  exhaustive routing test stubs expensive infrastructure handlers; it is a
  dispatch contract test, not a claim of live inference for every command.
- `test/nested-approval-runtime.test.mjs`: real kernel -> child task -> approved
  file write + structured question, using an in-process deterministic provider.
- `test/device-subagent-approval.test.mjs`: real DeviceService/kernel broker;
  a second client approves child work through the root, wrong routing and late
  decisions are denied, and parent cancellation prevents a pending write.
- `test/background-prompt-bridge.test.mjs`: real spawned Node processes over IPC,
  fixed task identity, cross-kernel isolation, disconnect and cancellation.
- Existing `background-worker-e2e` covers actual worker subprocess lifecycle,
  retry, forked history, worktrees and a real delegated write.
- `session-store-multiprocess` uses independent Node processes and an IPC
  barrier to reproduce stale-cache races: all independent children and parent
  updates survive, a buffered rewind preserves concurrent additions, duplicate
  fork IDs cannot overwrite history, and damaged shards are not replaced.
- `session-store-root-isolation` verifies deferred writes cannot migrate into
  another storage root when `KKCODE_HOME` changes between operations.

These deterministic checks do not replace Web/Android UI acceptance or enterprise
SSO/gateway integration tests recorded in the release implementation ledger.
