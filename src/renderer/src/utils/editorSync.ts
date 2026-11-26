// External-change reconciliation for the artifact editor: the open buffer
// is a cache of the disk, and the disk can move underneath it — a run-help
// write_artifact, another editor, git, the program itself. Pure decision
// logic (no React, no IPC) so unit tests compile it with the project's tsc
// and run it under node:test. EditorView gathers the inputs (a fresh disk
// read, the shown content, the draft baseline, the user's suppression) and
// applies the verdict.

export type ExternalChangeAction =
  // No draft: the disk version is newer than what is shown — take it.
  | { kind: 'reload' }
  // A draft exists and the disk moved away from the draft's baseline:
  // silently picking either side loses work, so the user decides.
  | { kind: 'conflict' }
  // Nothing to do: the shown content is current, or the disk is exactly
  // where the draft's baseline left it, or the user already chose to keep
  // their draft over THIS disk version.
  | { kind: 'none' }

export function decideExternalChange(input: {
  diskContent: string
  currentContent: string // what the editor shows now
  draftBase: string | null // the draft's disk baseline; null: no draft
  suppressedDisk: string | null // disk content the user kept their draft over
}): ExternalChangeAction {
  if (input.draftBase === null) {
    return input.diskContent === input.currentContent ? { kind: 'none' } : { kind: 'reload' }
  }
  // The disk never moved under the draft — the divergence is the user's
  // own unsaved work, not a conflict.
  if (input.diskContent === input.draftBase) return { kind: 'none' }
  // "Keep my draft" was already chosen for exactly this disk version; a
  // NEWER disk change re-arms the question.
  if (input.suppressedDisk !== null && input.diskContent === input.suppressedDisk) {
    return { kind: 'none' }
  }
  return { kind: 'conflict' }
}
