# UI design rules

Standing design doc for UI/UX work in Kimi Dock. Read it before planning any
change that adds or modifies a user-visible surface or interaction; include
the review checklist (§10) in the change's pull request description.

Distilled primarily from the beUI guide _AI Chat UI in React_ [1], extended
with the message-delivery discipline from [2][3], the scroll-behavior
canon from [4][5] and the external-file-change consensus from [6]–[10].
The rules are stated for this codebase; section 8 maps
them to the files that implement them.

## 1. Surface anatomy

An async chat surface has five parts. Keep them separate, so queue and
streaming logic never leaks into presentational components:

- **Message list** — rows for the user and the assistant, with avatar and
  timestamp.
- **Scroll viewport** — follows new output at the bottom and lets go when
  the reader scrolls up.
- **Response area** — the assistant text, with copy/retry actions that
  appear only once the response is complete, so they never jump around
  under growing content.
- **Prompt input (composer)** — an auto-growing textarea that sends on
  Enter and can turn into a stop button while a reply runs.
- **Loading states** — a calm thinking row for the gap between send and
  the first token.

## 2. The composer never blocks

- The input stays editable during any in-flight request; a new send queues
  behind the running one. Clearing the field waits at most for the local
  durable write, never for the network.
- Enter sends, Shift+Enter inserts a newline, and Enter is ignored while
  an input method editor is composing text (`e.nativeEvent.isComposing`).
- The textarea auto-grows with content up to a few lines.
- Keep focus in the composer after sending, so keyboard users can
  continue.

## 3. Message delivery lifecycle

Every outgoing message has an explicit lifecycle — `pending` → `synced`,
or `failed` — and the store is the single source of truth for it.

- Mint a stable client id **before** any request; the id survives retries.
  A retry re-delivers the same message, never a copy (idempotency).
- Append locally first, then deliver; reconcile by id on acknowledgement.
- A message already acknowledged is never re-sent: the deliverable set is
  exactly the pending/failed messages, recomputed from the store on every
  delivery pass — never cached across passes.
- Failures surface as a dismissible notice with a retry path — never as
  fabricated assistant content, and never by losing the user's text.
- Read-modify-write cycles on the stored conversation are serialized
  (a record lock), so the send path and the reply path cannot overwrite
  each other.

## 4. Scroll: follow, never fight

The bottom-at-latest position is the **live edge**; the policy is
**stick-to-bottom**.

- Follow new content only while the reader is at the live edge. Scrolling
  up — wheel, touch, or keyboard — releases the follow; scrolling back
  within a threshold re-engages it (this project: 100 px; the beUI
  component default: 56 px).
- Force-scroll only for the user's own just-sent message, and gate that on
  the last-message id actually changing: a queue-state flip over an old
  pending message must not yank a reader who scrolled up.
- Opening a conversation lands on the latest message. Scroll before paint
  (`useLayoutEffect`), so the list never flashes its top.
- For long histories, offer a jump-to-latest control while released.

## 5. Feedback and errors

- Every async action acknowledges itself: a thinking row between send and
  first token, a queued marker on undelivered messages, a typing indicator
  while a reply generates. (This project's offline chat streams: the typing
  indicator covers the send → first-token gap, then the growing provisional
  bubble is the progress signal; only the completed reply persists.)
- Silent failure is forbidden. Error text says what happened, why, and
  what to do next, in plain language, and preserves the user's input.

## 6. Surface switching preserves state

Keep-mounted surfaces (the webview, the artifact editor) keep their state
across switches. A CSS-hidden surface must gate its global listeners
(keydown and friends) on being active — hidden is not inert.

## 7. External file changes

The open buffer is a cache of the disk, and the disk can move underneath
it — another editor, git, a build, an AI assistant. The surveyed editors
(VS Code, Sublime Text, Zed, JetBrains IDEs, Vim — sources [6]–[10])
agree on four rules:

- **A clean buffer reloads silently.** With no unsaved work there is
  nothing to lose, so nobody asks — Sublime: "it only reloads without
  prompting when you have no unsaved changes" [6].
- **A dirty buffer is never silently resolved.** Editors differ only in
  WHEN they ask: at edit time (Sublime's reload/ignore choice [6],
  JetBrains' File Cache Conflict dialog [9]) or at save time (VS Code
  flags the divergence and asks on save [7]; Zed flags the buffer as
  modified rather than reloading [8]; Vim checks the timestamp before
  writing and asks y/n when it moved [10]). Asking at both points is
  legitimate; asking at neither loses work.
- **A save never overwrites a newer disk version silently.** The user
  who was shown the divergence and chose their draft may overwrite
  (Sublime's ignore-then-save [6]); otherwise the question belongs at
  save time, with Cancel as the default — a save gesture must not become
  a clobber gesture [7].
- **The view survives a reload.** Cursor and scroll position are
  preserved approximately, so even a silent reload does not cost the
  reader their place.

Here: revalidation on surface activation, window focus and run-help
writes reloads clean buffers and raises the conflict banner over a
diverged draft (the edit-time camp); the save-time guard reads the disk
before every write — single-file and save-all. The single-file save asks
natively (Overwrite / Load / Cancel, Cancel the default) from any
surface; save-all skips and reports the diverged drafts instead of
asking. "Keep my draft" suppresses exactly the shown disk version, so a
later save overwrites without re-asking (ignore-then-save).

## 8. Where this lives in the code

- Composer, stick-to-bottom, typing indicator (`.typing-indicator`), the
  streaming provisional bubble, and the send-error notice:
  `src/renderer/src/components/KimiWebView.tsx`; SSE parsing and delta
  classification: `src/main/chatStream.ts`.
- Message lifecycle (`seq`, `syncStatus`, `isUndelivered`):
  `src/renderer/src/utils/offlineManagerSchema.ts` (only `pending` is
  produced today; the schema reserves `failed` for a retry-exhausted
  state); queue flow helpers: `src/renderer/src/utils/chatFlow.ts`.
- Kept-mounted surfaces and their listener gating: `src/renderer/src/App.tsx`,
  `src/renderer/src/components/EditorView.tsx`.
- External-change machinery (§7): the reconciliation decision:
  `src/renderer/src/utils/editorSync.ts`; revalidation, the conflict
  banner and the save-time guard: `src/renderer/src/components/
  EditorView.tsx`; the save-all guard: `src/renderer/src/utils/
  draftStore.ts`; the native question: `confirm-save-conflict` in
  `src/main/index.ts`.

## 9. Accessibility minimum

- The transcript is a log region: `aria-live="polite"`, `aria-busy` while
  a reply runs; if a streaming component has its own live region, disable
  one of the two so text is not announced twice.
- Each message is an article labelled "user message" / "assistant message";
  the composer has an accessible label.
- Respect reduced motion: pop-in animations and smooth scrolling degrade
  to instant.

## 10. Review checklist for UI units

Paste this checklist into the pull request description of any UI change;
whoever reviews the change — human or an automated review pass — walks it
item by item.

- [ ] Composer never blocks; Enter / Shift+Enter / IME-composition handled
- [ ] Outgoing messages: stable client id, optimistic append, acknowledged
      messages never re-sent, deliverable set recomputed from the store
- [ ] Failure = dismissible notice + retry; no fabricated content; no lost
      user input
- [ ] Scroll follows only at the live edge; own send force-scrolls; opening
      lands on the latest message; scroll happens before paint
- [ ] Every async action has visible status; errors say what/why/next
- [ ] Surface switching preserves state; hidden surfaces gate global
      listeners
- [ ] External file changes: clean buffers reload silently; a diverged
      draft is never silently resolved; a save never overwrites a newer
      disk version silently
- [ ] a11y: log region, labels, reduced motion

## Sources

1. beUI — [AI Chat UI in React: Build a Streaming Chat Interface](https://beui.dev/guides/ai-chat-ui-react)
2. Ashish Bhakhand — [Optimistic Chat UI with Idempotent Server Turns](https://www.ashishbhakhand.com/blog/optimistic-chat-idempotent-turns-swift)
3. Jonas Stamm — [The Nightmare of Optimistic UI in Chat Apps](https://www.jonasstamm.com/optimistic-ui-chat-apps)
4. Devin Schulz — [Building a Chat Interface That Doesn't Fight Your Scroll Position](https://devinschulz.com/blog/building-a-chat-interface-that-doesnt-fight-your-scroll-position/)
5. OpenCode Portal — [Chat Interface](https://hosenur-portal.mintlify.app/features/chat-interface)
6. Sublime Text Forum — [alert instead of auto-refresh on external change](https://forum.sublimetext.com/t/9046) ("never silently discard your changes… only reloads without prompting when you have no unsaved changes")
7. microsoft/vscode — [issue #100504: file changed on disk, the save-over risk](https://github.com/microsoft/vscode/issues/100504)
8. zed-industries/zed — [issue #6260: a changed-on-disk buffer is flagged as modified, not silently reloaded](https://github.com/zed-industries/zed/issues/6260)
9. JetBrains intellij-community — [FileDocumentManager.java: the File Cache Conflict policy (ASK by default)](https://github.com/JetBrains/intellij-community/blob/master/platform/core-api/src/com/intellij/openapi/fileEditor/FileDocumentManager.java)
10. Neovim documentation — [editing: the timestamp check before writing ("The file has been changed since reading it!!! … (y/n)")](https://neovim.io/doc/user/editing.html)
