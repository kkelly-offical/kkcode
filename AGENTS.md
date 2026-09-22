# Project working memory

- User decision (2026-09-21): releases stay on `1.0.x`. Do not bump to `1.1.0` or another major/minor until the user explicitly authorizes that version change.
- Current preview target: `1.0.1-preview.2` (third round): M32/M33 completion, cross-platform gates, truthful media inputs, discovered pricing, model capability badges, remote MCP summaries, deferred tool discovery, hierarchical instructions and backward-compatible canonical tools. Release authorization includes merging to main and publishing npm `preview` + GitHub prerelease only; preserve stable `latest`. Publication/acceptance evidence belongs in the implementation and release ledgers.
- Android is a native Kotlin/Compose remote client (SSH and Relay), not an embedded local Agent runtime.
- Android version codes: preview.0 = `10001`, preview.1 = `10002`, preview.2 = `10003`. Every later public APK must keep incrementing that code while retaining the project release certificate. Signing keys remain outside Git and CI.
- User authorized switching CodeQL from default setup to a custom workflow on 2026-09-22, preserving JavaScript/Actions analysis and adding a real manual Android/Kotlin debug build; a Java-only `build-mode: none` pass is not Kotlin coverage.
- Remote is foreground-scoped: exiting the terminal stops remote exposure. Devices/sessions are private by default with explicit sharing. A trusted organization gateway may inspect traffic; content persistence is disabled by default.
- First binding assigns existing local history to that account. Folder browsing starts at the OS user's home, with credential paths protected.
- Preserve current CLI behavior and stable headless JSONL schema. Never record tokens, passwords, private keys or signing secrets in source or logs.
- Git author email: `24042203053@ecupl.edu.cn`.
- Track actual implementation and validation in `docs/implementation-1.0.1.md`; do not describe incomplete work as shipped.
- UI steering (2026-09-21): open on a compact device/session home, never a large configuration form. Keep connection/account settings behind menus and layered sheets. Mobile reference: dark conversation app, grouped session list, small device status header, bottom search/new-chat controls, grouped settings rows.
- Conversation UI steering (2026-09-21): compact gray expandable tool rows, real red/green diff counts, collapsed timed thinking, slash-command suggestions above the composer, and contextual device/folder selectors. Do not add decorative camera/microphone/branch actions without working implementations.
