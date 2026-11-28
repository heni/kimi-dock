// Chat-picker merge for the artifact editor: the picker shows CHATS,
// not directories, but a chat's directory on disk appears only on its
// first artifact (writeTextFile mkdirs on demand). Sources:
//   - every offline conversation (updatedAt desc, mirroring the
//     sidebar; the 'new' sentinel filtered out) — selectable even
//     without a directory: an empty artifact list and on-demand mkdir
//     mean nothing has to pre-exist;
//   - orphan directories (their conversation was deleted, the
//     artifacts remain) — appended, sorted by name.
// Pure (no React, no IPC) so unit tests compile it with the project's
// tsc and run it under node:test.

export interface PickerSourceConversation {
  id: string
  title: string
  updatedAt: number
}

export interface ChatPickerEntry {
  id: string
  title: string
  hasDir: boolean
}

// The sidebar's not-yet-created sentinel is never a picker target.
const SENTINEL_IDS = new Set(['new'])

export function mergeChatPickerEntries(
  conversations: PickerSourceConversation[],
  dirNames: string[]
): ChatPickerEntry[] {
  const dirs = new Set(dirNames.filter((name) => !SENTINEL_IDS.has(name)))
  const seen = new Set<string>()
  const entries: ChatPickerEntry[] = []
  // Recency order (mirrors the sidebar); sorted here, not assumed from
  // the caller.
  const byRecency = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const conv of byRecency) {
    if (SENTINEL_IDS.has(conv.id) || seen.has(conv.id)) continue
    seen.add(conv.id)
    const hasDir = dirs.delete(conv.id)
    entries.push({ id: conv.id, title: conv.title, hasDir })
  }
  // Orphan directories left in the set: artifacts whose conversation is
  // gone. Name as label, after the conversations.
  const orphans = [...dirs].sort((a, b) => a.localeCompare(b))
  for (const name of orphans) {
    entries.push({ id: name, title: name, hasDir: true })
  }
  return entries
}
