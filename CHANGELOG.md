# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.9.3] - 2026-11-28

### Added

- **The artifact chat picker lists conversations, not directories** —
  previously a brand-new chat was invisible until its first artifact
  created the directory (chicken-and-egg: nothing to select, nothing to
  create into). The picker now merges every offline conversation (most
  recent first, mirroring the sidebar; directory-less chats read "no
  artifacts yet" and are fully selectable — their directory is created
  on the first file) with orphan directories (artifacts of deleted
  conversations, listed by name). The editor sidebar header shows the
  open chat's title and works as a chat switcher (back to the picker),
  so the association is visible and switching needs no detour through
  the chat surface.
- e2e: a picker step — a directory-less conversation is selectable and
  its first created file mkdirs the directory (self-cleaning probe).

## [3.9.2] - 2026-11-27

### Added

- **Save-time conflict guard** — a save never silently overwrites a disk
  version the buffer does not know (the editor consensus: VS Code asks
  at save time, Sublime after an edit-time ignore, Vim on a moved
  timestamp). Every save reads the disk first and reconciles through the
  same decision the revalidation uses (`decideExternalChange` on the
  single-file path, the same rule inline in save-all): a clean stale
  buffer just takes the disk version; a draft whose disk moved away from
  its baseline raises a native question — **Overwrite Disk Version** /
  **Load Disk Version** (a fresh read at click time) / **Cancel**
  (default) — that works from any surface, unlike the editor-surface
  banner. "Keep my draft" in the banner suppresses exactly the shown
  disk version: saving after it overwrites without re-asking (Sublime
  ignore semantics, now stated in the button tooltip). Ctrl+K S
  (save-all) skips diverged drafts instead of writing them, reports
  them, and re-raises the banner for the open file.
- e2e: the save-time guard step (Cancel leaves the disk untouched,
  Overwrite lands the draft, Load takes a fresh disk read, a clean stale
  buffer reloads silently) with the native dialog driven by a
  main-process patch.

## [3.9.1] - 2026-11-26

### Added

- **The editor invalidates its buffer on external file changes** — the
  open file is re-read from disk when the editor surface becomes visible
  and when the window regains focus, and run-help writes reconcile
  through the same path. A clean buffer reloads silently; when the file
  has an unsaved draft and the disk moved away from the draft's baseline
  (an AI write or an external program), a banner asks instead of
  silently picking a side: "Load disk version" or "Keep my draft"
  (suppressed until the disk changes again). Previously the draft
  silently masked the AI's write and the next save destroyed it, and
  changes made outside the app never showed up until the file was
  reopened.
- e2e: an external-write invalidation step (self-restoring).

### Fixed

- **Ctrl+S now saves from any surface** — the shortcut was gated on the
  editor being visible, so the run-help write refusal ("save (Ctrl+S)
  and retry") instructed a dead key while the user sat on the chat
  surface. The editor-only shortcuts (chords, Ctrl+F5, Ctrl+Tab, preview
  keys) stay gated.

## [3.9.0] - 2026-11-26

### Added

- **AI run-help reads the live editor buffers** — every request of a
  run-help conversation pushes the chat's unsaved drafts to main, so
  `read_artifact` returns the buffer the user is actually looking at
  instead of the stale disk. Every read starts with a header line naming
  the source ("on disk" / "unsaved editor buffer"), the byte size and the
  modification time; `list_artifacts` names the files with unsaved
  buffers; the ✨ trigger flags a dirty file up front.
- **`write_artifact` tool** — the run-help assistant can create or
  overwrite files inside the chat directory (full content, 32 K-char
  cap). A write is refused while the target has unsaved editor changes —
  the model asks for a save (Ctrl+S) and retries, so unsaved work is
  never silently overwritten — and the open editor reloads a written
  file automatically. All run-help tool paths, reads and writes alike,
  are now confined by a symlink-aware (realpath) check on top of the
  lexical one.

### Changed

- **The run-help skill rides every pass of a marked conversation** (was:
  the trigger's request only) — the API is stateless, and follow-ups are
  exactly where the model answered from stale memory of earlier reads.
  The skill now carries the freshness contract (re-read in the current
  turn before quoting; quote the header's size/mtime, never compute
  them; never claim an unread re-read) and the actual run.json schema,
  so the model stops inventing the format.

## [3.8.0] - 2026-11-26

### Added

- **✨ Ask AI in the run console** — one click asks the AI about the
  current file's last run in the chat that owns the artifacts (Alt+click:
  in a fresh conversation). The trigger message stays in the history; the
  model answers through the tool-calling agent loop — the run's command,
  exit code and output tails, the chat's files and its run.json are
  available to it read-only — and the answer streams. Follow-up questions
  in the same conversation keep tool access; the run-help skill rides
  only the trigger's request. The button highlights after a failed run
  and is disabled with an explaining tooltip when logged out. If the
  offline chat is not visible (online and not forced), asking flips the
  persisted force-offline flag on — the title-bar badge shows it, one
  click flips back.
- The run console reports the command's source level (built-in /
  run.json / free-form) to the run-help tools.

## [3.7.0] - 2026-11-26

### Added

- **Tool-calling core in main (dark)** — the AI run-help infrastructure,
  not yet reachable from the UI (the ✨ button ships separately): an
  OpenAI-style agent loop over the streaming path (≤ 6 iterations; tool
  rounds are consumed inside main, the final answer streams as ordinary
  deltas), four read-only tools confined to the chat directory
  (`get_run_output`, `read_artifact`, `list_artifacts`, `get_run_json`),
  and a per-chat last-run record teed off the run console (command,
  source level, exit code, capped stdout/stderr tails). The
  `kimi-api-stream-start` payload gains a validated `runHelp` field.
  Covered by new unit tests (dispatch, streamed tool_calls assembly,
  the agent loop).

### Removed

- **The generic `kimi-api-request` proxy** — consumer-less since the
  offline chat moved to streaming in 3.6.0 (the tool loop runs
  main-side); the authenticated surface is removed rather than kept
  dark.

## [3.6.0] - 2026-11-26

### Added

- **Streaming replies in the offline chat** — the answer grows
  token-by-token instead of appearing as one block after the full
  generation: the typing indicator covers the send → first-token gap
  (the model's reasoning phase), then a provisional bubble renders the
  partial markdown live. Only the completed reply is persisted; a stream
  failure is an ordinary send failure (dismissible notice, the message
  stays queued for a retry).
- **Stop generating** — while a reply streams, the send button becomes
  ■: stopping keeps the partial reply (real model output); stopping
  after the request went out but before the first token delivers the
  message with no reply appended; stopping while the request is still
  being prepared leaves the message queued for the next send.

### Changed

- The offline chat's message list is a log region (`role="log"`,
  `aria-busy` while a reply generates) per the UI design doc's
  accessibility minimum.

## [3.5.12] - 2026-11-25

### Fixed

- **Ctrl+K V toggles the markdown split** instead of only enabling it —
  the split is a mode of the same pane, so it now behaves like its
  sibling Ctrl+Shift+V (split → edit, anything else → split). The 3.5.0
  implementation followed VS Code's command name, where the target is a
  tab, not a mode.

## [3.5.11] - 2026-11-25

### Changed

- **Test hardening, no behavior change** — the two decision cores that
  lived inside components (artifact cycling for Ctrl+Tab; the online
  transition's spinner/reload decision) are extracted into pure modules
  (`artifactNav`, `transition`) and covered by 12 unit tests: wrap
  directions, not-in-list states, single/empty lists, wedged failed loads,
  retry-in-flight, error-over-retry dominance.

## [3.5.10] - 2026-11-25

### Fixed

- **The exit warning no longer triggers GNOME's "not responding" banner** —
  the drafts question was a window-modal dialog attached to the very
  window whose close had just been cancelled — the suspected trigger of
  GNOME's force-quit timer. The dialog is now parentless (and single: a
  repeated close request while it is up does not stack another), and
  "Quit" re-issues the close with a force flag. (If the banner ever
  resurfaces, the documented fallback is hiding the window while the
  question is up.)

## [3.5.9] - 2026-11-25

### Changed

- **Unsaved edits are drafts now, not a confirm dialog** (the Sublime
  hot-exit model, session-scoped): every keystroke is written through to
  an in-memory per-file draft store, so switching files (clicks or
  Ctrl+Tab), surfaces or chats never loses work — the "Unsaved changes
  will be lost" dialog is gone. Files with drafts show a dot in the
  artifact list and in the chat picker; reopening a file restores its
  draft with the dirty state intact.

### Added

- **Ctrl+K S saves all drafts of the current chat** (VS Code's Save All
  chord; artifacts of other chats are never touched). Failures keep their
  drafts and are reported.
- **Chat-switch guard** — pointing the editor at another chat while the
  current one holds drafts asks first: Save all & switch / Switch anyway
  (drafts stay in memory) / Cancel, with the count.
- **Exit warning** — quitting the app with drafts open shows a native
  dialog with the total count (Quit / Keep editing); drafts live only in
  memory, so this is the one destructive path left.

## [3.5.8] - 2026-11-25

### Added

- **Artifact switching shortcuts** — Ctrl+Tab opens the next artifact of
  the chat, Ctrl+Shift+Tab the previous one (sequential, wrap-around; the
  honest analog of VS Code's Ctrl+PageUp/Down, since the editor has no
  tabs or MRU set). Switching routes through the normal open path, so the
  unsaved-changes confirmation protects cycling exactly as it protects
  clicking. Listed in the F1 help panel and the README table.

## [3.5.7] - 2026-11-25

### Changed

- **Offline↔online transitions are instant after the first load** — the
  webview is now kept mounted (CSS-hidden) when the offline view shows,
  the same pattern the artifact editor already used. Returning online no
  longer reloads kimi.ai: no revalidation storm, no lost web-chat state —
  the live SPA just reappears. The webview still mounts lazily (a boot
  into offline mode renders none until the first transition), and "Try
  Reconnecting"/"Reload Page" only reload when the first load never
  finished or failed — a loaded SPA self-heals reconnects.
- **Cold load shows a skeleton, not a black screen** — while kimi.ai
  loads, the placeholder mirrors the shape of its greeting (light page,
  logo block, input card, agent chips) with a shimmer (disabled under
  reduced motion) and an honest status line, instead of four seconds of
  black.
- **The webview loads `https://www.kimi.ai` directly**, skipping the
  302 redirect hop on every cold start.

## [3.5.6] - 2026-11-25

### Added

- **Editor shortcuts that work surface-wide** — Ctrl+S saves the current
  file from any focus inside the artifact editor (previously only while
  the code editor had keyboard focus, despite the button tooltip), and
  Ctrl+F5 runs the current file (VS Code's "Run Without Debugging"). Both
  live in the editor-surface-gated listener: a hidden editor intercepts
  nothing, and Ctrl+Shift+S (sidebar) is unaffected.
- **Shortcuts & help panel** — F1 or the title-bar "?" opens a built-in
  list of every keyboard shortcut plus explanations of the non-obvious
  buttons; Esc closes it. The README shortcut table is synced.

### Changed

- **The run console's bare "?" button is now labelled "AI: run.json"** —
  the glyph read as "help" while actually arming the run.json authoring
  skill; the tooltip now spells out what arming does.

## [3.5.5] - 2026-11-25

### Fixed

- **Assistant answers can be copied** — every assistant message in the
  offline chat has a copy button (next to the timestamp, no hover needed);
  it writes the raw markdown source through the clipboard bridge, with a
  ✓/✗ acknowledgement on the button. Previously the rendered answer could
  not be copied at all.

## [3.5.4] - 2026-11-25

### Fixed

- **Run commands work in paths with spaces (and quotes)** — placeholder
  values (`{file}`, `{dir}`, `{name}`, `{base}`) are now shell-quoted at
  substitution, so a workspace or chat directory containing spaces no
  longer splits the `bash -c` command in two. The owner-visible symptom
  was misleading: a Go run failed with `go: go.mod file not found` because
  `go run` received the truncated first half of the path as a package.
  Templates must not add their own quotes around placeholders (documented
  in the run.json skill); the `cwd` field stays a plain unquoted path —
  it is a spawn option, not shell input.

## [3.5.3] - 2026-11-25

### Fixed

- **Offline→online transition no longer hangs on the loading spinner** —
  when the app booted into offline mode, the webview's load listeners were
  never attached (the listener effect ran while no webview existed and did
  not re-run when one mounted), so `did-finish-load` never cleared the
  loading overlay and the retry-on-fail logic was dead. The effect now
  re-runs when the webview (re)mounts. The transition also shows the
  "Reconnecting..." overlay while the webview loads instead of a blank
  area, and "Try Reconnecting" drives the transition immediately instead
  of waiting for the 5-second connectivity poll.
- **e2e** — new step 8 regression-covers the boot-offline→online path
  (RED on the pre-fix code: the overlay never detached); the harness now
  presets `forceOfflineMode=false` itself when the profile was saved
  forced, and restores the original settings afterwards.

## [3.5.2] - 2026-11-25

### Fixed

- **Offline chat renders markdown and TeX** — assistant replies now render
  as formatted markdown (headers, bold, lists, code, tables; links open in
  the system browser) with TeX math typeset by KaTeX (inline `$…$` and
  display `$$…$$`), instead of showing the raw markup as plain text. User
  messages stay plain text. The artifact editor's markdown preview gains
  the same TeX support through the now-shared renderer. Raw HTML in
  messages stays escaped (markdown-it `html: false`, KaTeX `trust: false`),
  and a broken formula degrades to red source text instead of failing the
  message.

## [3.5.1] - 2026-11-25

### Fixed

- **Offline chat auto-scroll** — the conversation now follows the exchange:
  opening a chat lands on the latest message, sending a message scrolls it
  into view, and replies and the typing indicator keep the list pinned to
  the bottom. Scrolling up into history disengages the pin, so an arriving
  reply no longer yanks the view; scrolling back to the bottom re-engages
  it.

## [3.5.0] - 2026-11-24

### Added

- **Artifact editor** — a third surface next to the webview and the offline
  chat, available in any network state: the title-bar toggle opens it, the
  📁 Artifacts button in the offline chat header opens it on the current
  chat. The webview stays mounted and is CSS-hidden, so switching is instant
  and the kimi.ai session keeps its state. Each chat owns a directory
  `<workspace>/<chatId>/`; every non-hidden file in it is an artifact of the
  chat (dot-files stay hidden from the list but remain accessible). Create,
  edit and save files (Ctrl+S) with dirty tracking.
- **Workspace folder** — the user-chosen root of the per-chat artifact
  directories (Settings → General). It is an API-gateway entity: the
  renderer reaches the disk only through the main process, which normalizes
  every path and refuses anything escaping the root.
- **Markdown editing** — edit ↔ preview toggle plus a split view with
  two-way scroll sync (Ctrl+Shift+V / Ctrl+K V). Rendering is markdown-it
  with `html: false`: raw HTML in the source is escaped, so the preview
  needs no sanitizer.
- **Code editing** — CodeMirror 6 with syntax highlighting by file
  extension.
- **Run console (tier 1)** — a panel docked under the editor: run the
  current file via `/bin/bash -c` in the chat directory with streaming
  stdout/stderr, the exit code and a Stop button. The command is resolved in
  three levels, later wins: a built-in extension table (zero configuration)
  < `run.json` at the chat directory root (glob → command template with
  `{file}`/`{dir}`/`{name}`/`{base}` placeholders, `env`/`cwd`/`timeoutSec`,
  most specific glob wins) < a free-form command with per-chat history.
  Files are saved before the run. There is no stdin — interactive programs
  do not fit tier 1.
- **run.json assistant skill** — the "?" button in the run panel arms the
  skill: the offline chat attaches the run.json instructions to outgoing
  messages (as a system message, never persisted), so the assistant can
  propose a ready-made configuration for the user's case.

## [3.4.1] - 2026-11-24

### Fixed

- **Offline chat no longer blocks typing while a reply is pending** — the
  input and send button were disabled until the answer arrived, which without
  network could take arbitrarily long. Messages now queue as `pending` and a
  serial queue delivers them; the input stays live and queued messages retry
  on the next send or when the network returns.
- **Shift+Enter inserts a newline** — the single-line input is now a
  multiline textarea: Enter sends, Shift+Enter breaks the line, and the field
  auto-grows to a few lines.
- **Answered messages are no longer re-sent** — the chat view kept a second,
  unsaved message list that was merged into the conversation on every save
  and never cleared, so answered messages duplicated in the database and went
  into every subsequent API request multiple times. The send flow now keeps a
  single message list on the v3 sync schema: each request carries every
  message exactly once, and exactly the sent messages are marked `synced`
  when the reply lands.
- **Fresh chats no longer overwrite each other** — "New Chat" in the sidebar
  used a shared placeholder id, so consecutive new chats saved into one
  record. The first send now mints a real id.
- **Failed sends no longer write fake assistant messages** — a failed request
  used to append an assistant-looking error to the chat, which then went back
  to the API as conversation context. Failures now show a dismissible notice
  and leave the message queued.
- **Sidebar order is stable again** — the 10-second autosave stamped
  `updatedAt` on every tick, re-sorting the conversation list without any
  user activity; conversations are now saved on activity only.

## [3.4.0] - 2026-11-24

### Added

- **Force offline mode** — an explicit switch for the offline chat UI that
  no longer requires pulling the network cable. A quick toggle button in the
  title bar (cloud-off icon) and a checkbox in Settings → Advanced flip one
  persisted setting (`forceOfflineMode`); the title bar badge reads "Forced
  Offline" to distinguish the state from a real network outage. In forced
  mode the offline view hides "Try Reconnecting" (reloading the hidden
  webview is meaningless there). Chat behavior is unchanged: responses still
  go through the Kimi Code API proxy, so offline mode keeps its established
  semantics — local persistence works without network, answers do not.

### Removed

- The "Enable Offline Mode" setting from Settings → General — it was a no-op
  left from upstream (never read by any code path; saved conversations are
  always accessible). Settings files carrying the stale key are cleaned up on
  the first save after upgrade.

## [3.3.1] - 2026-11-22

### Removed

- The constant "Kimi Code" badge from the title bar — a leftover of the
  upstream API-endpoint indicator: with a live session the green check
  already carries the same information. The offline chat's "Kimi Code Ready"
  badge is unchanged.

## [3.3.0] - 2026-11-21

### Fixed

- **Schema migrations no longer erase saved conversations** — the local chat
  database recreated its entire object store on every schema bump, which
  would have deleted all offline conversations at the first version change.
  Upgrades are now additive: the v2→v3 migration keeps every conversation
  and adds the new fields in place, with all timestamps preserved
  byte-for-byte.
- **`updatedAt` semantics fixed at the storage layer** — the store stamped
  `updatedAt` with the current time on every save, so imports and operational
  writes silently rewrote history and re-sorted the conversation list.
  Records are now written as given: `updatedAt` means "last user-visible
  activity" and is set by the caller; imported conversations keep their
  original timestamps. (The offline-chat autosave still refreshes
  `updatedAt` while a chat is open; that flow is reworked with the upcoming
  sync queue.)

### Added

- **Sync-ready message schema** — each message carries a per-conversation
  sequence number (monotonic, issued by the store) and a sync status
  (`pending` / `syncing` / `synced` / `failed`); each conversation carries a
  `hasPending` flag, indexed as the basis of the future offline sync queue.
  Conversations saved by older versions are backfilled automatically
  (`synced`, sequence by position).
- **Database migration test** — `npm run test:e2e:migration` seeds a
  database from the previous schema in a throwaway profile and verifies that
  the app migrates it without data loss, that the backfill lands, and that
  the conversation list still shows the migrated chats.

## [3.2.1] - 2026-11-21

### Fixed

- **Google sign-in actually opens the account-picker popup** — the 3.2.0 flow
  never surfaced the popup: `allowpopups` was set on the webview imperatively
  after guest attach, and a webview that gains the attribute later still drops
  every `window.open` from the guest (observed Electron 39). The attribute is
  now rendered by React at element creation, so it is present at attach time.
- **FedCM neutralization is now deterministic** — instead of patching
  `CredentialsContainer.prototype.get` from the embedder (which landed
  unreliably after guest navigations), the app disables the `FedCm`
  Chromium feature, so identity requests reject natively with
  `NotSupportedError` and Google Identity Services reliably falls back to its
  OAuth popup.

## [3.2.0] - 2026-11-20

### Added

- **Google sign-in in the webview** — "Continue with Google" now completes:
  the app neutralizes FedCM in the guest page (Google Identity Services only
  falls back to its OAuth popup when FedCM is unavailable; this Chromium
  throws while parsing GIS's FedCM options, which GIS does not treat as
  unavailable), hosts the resulting accounts.google.com popup in-app, and
  closes it after the redirect back to kimi.ai, reloading the webview into
  the logged-in state. Requires the `allowpopups` attribute on the webview
  (made reliable in 3.2.1: it must be present at guest-attach time).

### Fixed

- The webview silently dropped every `window.open` (including external
  links) because the `allowpopups` attribute never made it into the DOM;
  popups are now routed: identity-provider login popups stay in-app,
  everything else opens in the system browser.

## [3.1.0] - 2026-11-20

Kimi Dock releases (fork of kimi-desktop; versions before 3.0.0 belong to the
upstream project).

### Added

- **Clipboard bridge** — renderer access to the system clipboard through the
  main process: read text / native HTML / rich-text (RTF converted to HTML)
  / images (as data URLs); write text / HTML (with plain-text fallback) /
  images. Formats are enum-restricted over IPC, writes are size-capped, and
  failed image decodes are reported.

### Security

- **Renderer-to-main bridge hardening** — the API proxy accepts no path
  other than `GET`/`POST /chat/completions` (no GET bodies), every userData
  file access is resolved and confined to the userData directory,
  payload-bearing IPC handlers validate their inputs, and the
  `removeAllListeners` hole is removed from the preload bridge.
- Main-process CSP no longer allows `*.moonshot.ai` (leftover of the removed
  Moonshot API-key mode); both CSP enforcement points are in sync.

## [3.0.0] - 2026-11-19

### Changed

- **Kimi Code Plan authentication** — the upstream Moonshot API-key mode is
  replaced with OAuth 2.0 Device Authorization Grant against a Kimi Code
  Plan subscription (`api.kimi.com/coding/v1`). The token never leaves the
  main process (`kimi-code.json`, mode 0600); the model list is fetched at
  login and user-selectable in Settings. Product renamed to Kimi Dock.

### Added

- **arm64 deb packaging with AppArmor** — Ubuntu arm64 `.deb` with a
  postinst-installed AppArmor `userns` profile so the Chromium sandbox stays
  enabled (SUID workarounds rejected by design; AppImage not shipped because
  the profile cannot be packaged into it).
- **Playwright e2e smoke test** — `npm run test:e2e`: window shell, live
  OAuth session, webview target, clipboard roundtrips.

## [v2.0.1] - 2026-02-18

### ✨ Added

- **Offline Support** - Comprehensive offline detection with retry logic and auto-reconnect
- **System Tray Integration** - Minimize to tray, quick access menu, background running
- **Deep Linking Support** - `kimi://` protocol handler for opening specific chats
- **Window State Persistence** - Remembers size, position, and maximized state between sessions
- **Keyboard Shortcuts**
  - `Ctrl/Cmd + R` - Reload page
  - `Ctrl/Cmd + Shift + R` - Force reload (ignore cache)
  - `Ctrl/Cmd + +` - Zoom in
  - `Ctrl/Cmd + -` - Zoom out
  - `Ctrl/Cmd + 0` - Reset zoom
- **Auto-Retry Logic** - Exponential backoff retry (3 attempts) when loading fails
- **Security Hardening**
  - Content Security Policy (CSP) headers
  - Context isolation enabled
  - Sandboxing for webview content
  - Permission request handling
- **Error Boundaries** - Graceful handling of React crashes with restart option
- **Loading States** - Improved loading spinner with retry count display
- **Console Forwarding** - WebView console messages forwarded to main process for debugging
- **App Version Display** - Version shown in title bar

### 🔧 Changed

- **Refactored Styles** - Moved all inline styles to dedicated CSS files
  - `KimiWebView.css` - All webview, loading, offline, and error styles
  - `TitleBar.css` - All title bar and window control styles
- **Improved WebView Configuration**
  - Added `partition="persist:kimi"` for persistent session storage
  - Fixed `allowpopups` syntax for proper popup handling
  - Corrected `webpreferences` format (comma-separated with yes/no values)
  - Added custom user agent string
- **Enhanced Title Bar**
  - Added SVG icons for window controls (minimize, maximize, close)
  - Added app icon and version display
  - Improved hover states and visual feedback

### 🐛 Fixed

- Fixed webview not loading CSS/styles properly
- Fixed `allowpopups` incorrect syntax causing rendering issues
- Fixed CSP blocking external resources from kimi.com
- Fixed webview session not persisting cookies/storage
- Fixed window not remembering maximized state on restart

## [v1.2.0] - 2026-02-16

### 🐛 Bug Fixes

- Fixed bottom content cut-off issue with 100vh/100dvh layout
- Fixed initial window size constraints

## [v1.0.0] - 2026-02-14

- Initial release of Kimi Desktop
- Basic webview wrapper for kimi.com
- Custom title bar implementation
