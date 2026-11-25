// Artifact cycling arithmetic for Ctrl+Tab / Ctrl+Shift+Tab (extracted
// from EditorView's keydown for testability). Sequential over the chat's
// artifact list with wrap-around; no tabs/MRU (the honest analog of VS
// Code's Ctrl+PageUp/Down).

// Returns the path to open next, or null for a no-op (empty list, or the
// only file is already open). `current` may be null (nothing open) or
// missing from the list (deleted/renamed) — forward then opens the first
// artifact, backward the last. Backward from the first position wraps to
// the last.
export function nextArtifactPath(
  paths: string[],
  current: string | null,
  backward: boolean
): string | null {
  if (paths.length === 0) return null
  const idx = current ? paths.indexOf(current) : -1
  const next = backward
    ? paths[idx <= 0 ? paths.length - 1 : idx - 1]
    : paths[(idx + 1) % paths.length]
  return next === current ? null : next
}
