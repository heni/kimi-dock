// In-memory per-file drafts (Sublime's hot-exit idea, session-scoped):
// switching files, surfaces or chats never loses unsaved edits — the only
// destructive event left is application exit, which main gates with a
// dialog driven by the count pushed from here. Module singleton: survives
// the EditorView remount on chat switches.
//
// Pure except saveAllDrafts (window.api) — unit tests cover the pure part.

export interface Draft {
  content: string
  base: string // last known disk content — the dirty baseline
}

const drafts = new Map<string, Draft>() // key: `${chatId} ${path}`
const listeners = new Set<() => void>()

const key = (chatId: string, path: string): string => `${chatId} ${path}`

function notify(): void {
  for (const fn of listeners) fn()
}

export function subscribeDrafts(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// Write-through on every keystroke; an entry exists only while the draft
// differs from its disk baseline, so clean states self-delete.
export function setDraft(chatId: string, path: string, content: string, base: string): void {
  const k = key(chatId, path)
  if (content === base) {
    if (drafts.delete(k)) notify()
    return
  }
  const prev = drafts.get(k)
  if (prev && prev.content === content && prev.base === base) return
  drafts.set(k, { content, base })
  notify()
}

export function getDraft(chatId: string, path: string): Draft | undefined {
  return drafts.get(key(chatId, path))
}

export function clearDraft(chatId: string, path: string): void {
  if (drafts.delete(key(chatId, path))) notify()
}

export function hasDraft(chatId: string, path: string): boolean {
  return drafts.has(key(chatId, path))
}

export function dirtyPaths(chatId: string): string[] {
  const prefix = `${chatId} `
  const out: string[] = []
  for (const k of drafts.keys()) {
    if (k.startsWith(prefix)) out.push(k.slice(prefix.length))
  }
  return out.sort()
}

export function dirtyCount(chatId?: string): number {
  if (chatId === undefined) return drafts.size
  const prefix = `${chatId} `
  let count = 0
  for (const k of drafts.keys()) {
    if (k.startsWith(prefix)) count += 1
  }
  return count
}

// Save every dirty draft of ONE chat (Ctrl+K S semantics: artifacts of
// other chats are never touched). Entries clear on successful writes;
// failures keep their drafts and are reported by count.
export async function saveAllDrafts(chatId: string): Promise<{ saved: number; failed: number }> {
  const prefix = `${chatId} `
  let saved = 0
  let failed = 0
  for (const [k, draft] of [...drafts.entries()]) {
    if (!k.startsWith(prefix)) continue
    const path = k.slice(prefix.length)
    const result = await window.api?.fsWrite(`${chatId}/${path}`, draft.content)
    if (result?.success) {
      drafts.delete(k)
      saved += 1
    } else {
      failed += 1
    }
  }
  if (saved > 0) notify()
  return { saved, failed }
}
