import { useCallback, useEffect, useRef, useState } from 'react'
import CodeEditor, { CodeEditorHandle } from './CodeEditor'
import MarkdownPreview from './MarkdownPreview'
import RunPanel from './RunPanel'
import { offlineManager } from '../utils/offlineManager'
import {
  setDraft,
  getDraft,
  hasDraft,
  dirtyCount,
  clearDraft,
  resolveSave,
  saveAllDrafts
} from '../utils/draftStore'
import { decideExternalChange } from '../utils/editorSync'
import { nextArtifactPath } from '../utils/artifactNav'
import '../assets/EditorView.css'

interface EditorViewProps {
  chatId: string | null
  active: boolean
  onClose: () => void
  skillArmed: boolean
  onToggleSkill: () => void
  // Picker selections are reported up so App's chat-switch draft guard
  // knows which chat the editor is on.
  onChatSelected?: (chatId: string) => void
  hasSession: boolean
  // ✨ Ask AI in the run panel: App switches to the chat and enqueues the
  // trigger. chatId here is the editor's chat (the tools' target).
  onAskAi: (input: { chatId: string; text: string; newChat: boolean }) => void
}

interface ArtifactFile {
  path: string
  size: number
  mtimeMs: number
}

type ViewMode = 'edit' | 'split' | 'preview'

const isMarkdown = (path: string | null): boolean => path !== null && /\.(md|markdown)$/i.test(path)

// The editor surface: artifacts of one chat directory (<workspace>/<chatId>/),
// markdown preview with scroll sync, and the tier-1 run console docked below.
export default function EditorView({
  chatId,
  active,
  onClose,
  skillArmed,
  onToggleSkill,
  onChatSelected,
  hasSession,
  onAskAi
}: EditorViewProps): React.JSX.Element {
  const [activeChatId, setActiveChatId] = useState<string | null>(chatId)
  const [workspaceState, setWorkspaceState] = useState<'loading' | 'ready' | 'unset'>('loading')
  const [chatDirs, setChatDirs] = useState<Array<{ id: string; title: string }>>([])
  const [files, setFiles] = useState<ArtifactFile[]>([])
  const [currentFile, setCurrentFile] = useState<string | null>(null)
  // Mirrors currentFile for post-await guards: a save that resolves after
  // the user switched files must not touch the new file's baseline.
  const currentFileRef = useRef<string | null>(null)
  useEffect(() => {
    currentFileRef.current = currentFile
  }, [currentFile])
  const [fileContent, setFileContent] = useState('')
  // Mirrors fileContent for post-await guards (revalidation vs openFile
  // races), same discipline as currentFileRef.
  const fileContentRef = useRef('')
  useEffect(() => {
    fileContentRef.current = fileContent
  }, [fileContent])
  const [savedContent, setSavedContent] = useState('')
  // Disk-divergence conflict: the open file has a draft AND the disk moved
  // away from the draft's baseline (a run-help write or an external
  // change). The banner asks; silently picking a side would lose work.
  const [diskConflict, setDiskConflict] = useState<{
    path: string
    diskContent: string
  } | null>(null)
  // "Keep my draft" remembers the disk version it was chosen over; only a
  // NEWER disk change re-arms the banner.
  const suppressedDiskRef = useRef(new Map<string, string>())
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [error, setError] = useState<string | null>(null)
  const [newFileName, setNewFileName] = useState<string | null>(null)
  const editorHandleRef = useRef<CodeEditorHandle | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const scrollSyncingRef = useRef(false)
  const chordRef = useRef(false)
  // RunPanel registers its run handler here; the gated keydown below fires
  // it on Ctrl+F5.
  const runTriggerRef = useRef<(() => Promise<void>) | null>(null)
  const registerRun = useCallback((fn: (() => Promise<void>) | null): void => {
    runTriggerRef.current = fn
  }, [])

  const dirty = fileContent !== savedContent

  // Workspace root: set → load chat dirs for the picker; unset → prompt.
  const initWorkspace = useCallback(async (): Promise<void> => {
    setWorkspaceState('loading')
    const result = await window.api?.fsList('')
    if (!result?.success) {
      setWorkspaceState('unset')
      return
    }
    const dirs = (result.entries ?? []).filter((e) => e.isDirectory)
    let titles = new Map<string, string>()
    try {
      const conversations = await offlineManager.getAllConversations()
      titles = new Map(conversations.map((c) => [c.id, c.title]))
    } catch {
      // titles are cosmetic — fall back to ids
    }
    setChatDirs(dirs.map((d) => ({ id: d.name, title: titles.get(d.name) ?? d.name })))
    setWorkspaceState('ready')
  }, [])

  useEffect(() => {
    void initWorkspace()
  }, [initWorkspace])

  const refreshFiles = useCallback(async (): Promise<void> => {
    if (!activeChatId) return
    const result = await window.api?.fsListRecursive(activeChatId)
    if (result?.success) {
      setFiles(result.files ?? [])
    } else {
      setError(result?.error ?? 'Failed to list artifacts')
    }
  }, [activeChatId])

  useEffect(() => {
    void refreshFiles()
  }, [refreshFiles])

  // The workspace root can change while the editor stays mounted (Settings →
  // Workspace Folder): the open buffer belongs to the old root, so close it
  // and re-init instead of writing it into the new root on the next save.
  const workspaceRootRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    window.api
      ?.getSettings?.()
      .then((settings) => {
        if (!cancelled && workspaceRootRef.current === undefined) {
          workspaceRootRef.current = settings?.workspaceRoot ?? null
        }
      })
      .catch(() => {})
    const off = window.api?.onSettingsChanged?.((settings) => {
      const next = settings?.workspaceRoot ?? null
      const prev = workspaceRootRef.current
      workspaceRootRef.current = next
      if (prev === undefined || prev === next) return
      setCurrentFile(null)
      setFileContent('')
      setSavedContent('')
      void initWorkspace()
      void refreshFiles()
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [initWorkspace, refreshFiles])

  // Open a file. Unsaved edits are never lost: every keystroke is written
  // through to the draft store, so switching simply restores the target's
  // draft (content + its disk baseline) when one exists — no confirm
  // dialog, Sublime-style.
  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (!activeChatId) return
      const draft = getDraft(activeChatId, path)
      if (draft) {
        setCurrentFile(path)
        setFileContent(draft.content)
        setSavedContent(draft.base)
        setError(null)
        if (!isMarkdown(path)) setViewMode('edit')
        return
      }
      const result = await window.api?.fsRead(`${activeChatId}/${path}`)
      if (result?.success && result.content !== undefined) {
        setCurrentFile(path)
        // A keystroke during the read lands in the draft store and is newer
        // than the disk just read — the draft wins (the same post-await
        // re-check saveCurrentFile does), otherwise the visible content
        // would silently roll back to the disk.
        const raced = getDraft(activeChatId, path)
        setFileContent(raced ? raced.content : result.content)
        setSavedContent(raced ? raced.base : result.content)
        setError(null)
        if (!isMarkdown(path)) setViewMode('edit')
      } else {
        setError(result?.error ?? 'Failed to open the file')
      }
    },
    [activeChatId]
  )

  // Re-read the open file from disk and reconcile (decideExternalChange):
  // an external change — a run-help write, another editor, git, the
  // program itself — reloads the clean buffer, or asks via the conflict
  // banner when a draft diverges. The disk read is the only await, and the
  // draft lookup happens after it, so a keystroke during the read is
  // already reflected in the decision (no rollback of fresh input).
  const revalidateOpenFile = useCallback(async (): Promise<void> => {
    if (!activeChatId) return
    const path = currentFileRef.current
    if (!path) return
    const result = await window.api?.fsRead(`${activeChatId}/${path}`)
    if (!result?.success || result.content === undefined) return
    if (currentFileRef.current !== path) return // switched away mid-read
    const draft = getDraft(activeChatId, path)
    const action = decideExternalChange({
      diskContent: result.content,
      currentContent: fileContentRef.current,
      draftBase: draft ? draft.base : null,
      suppressedDisk: suppressedDiskRef.current.get(path) ?? null
    })
    if (action.kind === 'reload') {
      setFileContent(result.content)
      setSavedContent(result.content)
      setDiskConflict((current) => (current?.path === path ? null : current))
    } else if (action.kind === 'conflict') {
      setDiskConflict({ path, diskContent: result.content })
    } else {
      setDiskConflict((current) => (current?.path === path ? null : current))
    }
  }, [activeChatId])

  // External-change invalidation: the open buffer is a disk cache, so it
  // is re-read when the editor surface becomes visible and when the window
  // regains focus (a run-help write lands while the user sits on the chat
  // surface; vim/git/another editor strike while it is anywhere). The
  // artifact list refreshes alongside. Identical content is a no-op
  // (same-value state bails out), so an idle switch costs one small read.
  useEffect(() => {
    if (!active) return
    void refreshFiles()
    void revalidateOpenFile()
    const onFocus = (): void => void revalidateOpenFile()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, refreshFiles, revalidateOpenFile])

  // AI run-help writes land on disk while the user sits on the chat
  // surface: refresh the artifact list, and reconcile the open file
  // through the same conflict-aware path (a draft no longer silently
  // masks the AI's version — the banner asks).
  useEffect(() => {
    const off = window.api?.onRunHelpArtifactWritten?.((payload) => {
      if (!activeChatId || payload.chatId !== activeChatId) return
      void refreshFiles()
      if (payload.path === currentFileRef.current) void revalidateOpenFile()
    })
    return off
  }, [activeChatId, refreshFiles, revalidateOpenFile])

  // The conflict banner and the suppressions are per chat/file: switching
  // either forgets them (a suppression never leaks into another context).
  useEffect(() => {
    setDiskConflict(null)
    suppressedDiskRef.current.clear()
  }, [activeChatId, currentFile])

  // Take the disk version into the buffer, dropping the draft: the shared
  // "Load disk version" action of the conflict banner and the save-time
  // dialog. The content is always re-read at decision time — the banner
  // or the dialog may have sat while the disk moved again, and applying
  // the stale snapshot would let the next save silently clobber that
  // newer version. Returns whether the disk version landed (the save
  // path reports it to RunPanel: a successful load leaves the file on
  // disk ready to run, exactly like the clean-stale reload).
  const loadFreshDiskVersion = useCallback(
    async (path: string): Promise<boolean> => {
      if (!activeChatId) return false
      const fresh = await window.api?.fsRead(`${activeChatId}/${path}`)
      if (currentFileRef.current !== path) return false // switched away mid-read
      if (fresh?.success && fresh.content !== undefined) {
        clearDraft(activeChatId, path)
        suppressedDiskRef.current.delete(path)
        setFileContent(fresh.content)
        setSavedContent(fresh.content)
        setDiskConflict((current) => (current?.path === path ? null : current))
        return true
      }
      // Keep the draft and leave the conflict up — the user can retry.
      setError(fresh?.error ?? 'Failed to load the disk version')
      return false
    },
    [activeChatId]
  )

  // Save-time guard: a save must never silently overwrite a disk version
  // the buffer does not know (editor consensus — VS Code asks at save
  // time, Sublime after an edit-time ignore, Vim W12). The disk is read
  // before every write and reconciled by the same decideExternalChange
  // the revalidation uses: a clean stale buffer just takes the disk
  // version (nothing to save), a diverged draft raises the native
  // question — it works from any surface, unlike the banner. The ref
  // only narrows the reentrancy window (it is set after the guard read
  // resolves): the actual no-stacked-dialogs guarantee is the main
  // process's synchronous in-flight flag, which answers a racing second
  // question with 'cancel'.
  const saveGuardRef = useRef(false)
  const saveCurrentFile = useCallback(async (): Promise<boolean> => {
    if (!activeChatId || !currentFile) return false
    if (saveGuardRef.current) return false
    const path = currentFile
    const written = fileContent
    const disk = await window.api?.fsRead(`${activeChatId}/${path}`)
    if (currentFileRef.current !== path) return false // switched mid-read
    if (disk?.success && disk.content !== undefined) {
      const draft = getDraft(activeChatId, path)
      const action = decideExternalChange({
        diskContent: disk.content,
        currentContent: written,
        draftBase: draft ? draft.base : null,
        suppressedDisk: suppressedDiskRef.current.get(path) ?? null
      })
      if (action.kind === 'reload') {
        // Clean buffer, newer disk: take it (loss-free) — there is
        // nothing to save, and the file on disk is ready for RunPanel.
        setFileContent(disk.content)
        setSavedContent(disk.content)
        setDiskConflict((current) => (current?.path === path ? null : current))
        return true
      }
      if (action.kind === 'conflict') {
        saveGuardRef.current = true
        let choice: 'overwrite' | 'load' | 'cancel' | undefined
        try {
          choice = await window.api?.confirmSaveConflict(path)
        } finally {
          saveGuardRef.current = false
        }
        if (currentFileRef.current !== path) return false // switched mid-dialog
        if (choice === 'load') {
          // A successful load ends in the reload branch's state — the
          // disk version is ready, so a pre-run save reports success.
          return await loadFreshDiskVersion(path)
        }
        if (choice !== 'overwrite') return false // cancel, or the dialog failed
        // Overwrite: the user was shown the divergence and chose the
        // draft — fall through to the write.
      }
    }
    // A failed guard read keeps the pre-guard behavior (e.g. the file was
    // deleted externally — saving recreates it).
    const result = await window.api?.fsWrite(`${activeChatId}/${path}`, written)
    if (result?.success) {
      // The user may have switched files during the write: the baseline of
      // whatever is open NOW must not be touched then.
      if (currentFileRef.current === path) setSavedContent(written)
      // A keystroke that raced the write survives, re-based onto disk.
      resolveSave(activeChatId, path, written)
      // The draft is on disk now — any divergence question is settled.
      suppressedDiskRef.current.delete(path)
      setDiskConflict((current) => (current?.path === path ? null : current))
      setError(null)
      return true
    }
    setError(result?.error ?? 'Failed to save the file')
    return false
  }, [activeChatId, currentFile, fileContent, loadFreshDiskVersion])

  // Ctrl+K S: save every dirty draft of THIS chat (other chats are never
  // touched). Failures keep their drafts and are reported; the current
  // file's baseline advances only if its own write landed. Drafts whose
  // disk moved away from their baseline since the last revalidation are
  // SKIPPED, not silently written (the save-time guard, same rule as
  // saveCurrentFile): the current file's skip re-raises the banner via
  // revalidation, the rest are reported by count. The content is read
  // through the ref so this callback's identity — and with it the gated
  // keydown listener — stays stable across keystrokes.
  const handleSaveAll = useCallback(async (): Promise<void> => {
    if (!activeChatId) return
    const fileAtStart = currentFile
    const { failed, conflicts } = await saveAllDrafts(
      activeChatId,
      (path, diskContent) => suppressedDiskRef.current.get(path) === diskContent
    )
    if (
      fileAtStart &&
      currentFileRef.current === fileAtStart &&
      !hasDraft(activeChatId, fileAtStart)
    ) {
      setSavedContent(fileContentRef.current)
    }
    if (conflicts.includes(fileAtStart ?? '')) void revalidateOpenFile()
    // Divergence questions and suppressions settle wholesale only when
    // EVERY save landed: on a partial failure or a skipped conflict the
    // affected files' drafts and suppressions stay consistent (their disk
    // never moved under our write, so nothing would re-ask — the question
    // must stay up).
    if (failed === 0 && conflicts.length === 0) {
      suppressedDiskRef.current.clear()
      setDiskConflict(null)
    }
    const problems: string[] = []
    if (failed > 0) problems.push(`failed to save ${failed} draft${failed === 1 ? '' : 's'}`)
    if (conflicts.length > 0) {
      problems.push(`${conflicts.length} skipped (changed on disk): ${conflicts.join(', ')}`)
    }
    setError(problems.length > 0 ? problems.join('; ') : null)
  }, [activeChatId, currentFile, revalidateOpenFile])

  // Conflict banner actions: take the disk version (the draft goes away)
  // or keep the draft (suppressed until the disk changes again).
  const handleConflictLoadDisk = async (): Promise<void> => {
    if (!diskConflict) return
    await loadFreshDiskVersion(diskConflict.path)
  }

  const handleConflictKeepDraft = (): void => {
    if (!diskConflict) return
    suppressedDiskRef.current.set(diskConflict.path, diskConflict.diskContent)
    setDiskConflict(null)
  }

  const handleCreateFile = async (): Promise<void> => {
    const name = newFileName?.trim()
    if (!name || !activeChatId) return
    if (name.startsWith('/') || name.split('/').includes('..')) {
      setError('Invalid file name')
      return
    }
    // fsWrite truncates: creating over an existing artifact would silently
    // destroy it (and orphan its draft).
    if (files.some((file) => file.path === name)) {
      setError('A file with this name already exists')
      return
    }
    const result = await window.api?.fsWrite(`${activeChatId}/${name}`, '')
    if (result?.success) {
      setNewFileName(null)
      await refreshFiles()
      await openFile(name)
    } else {
      setError(result?.error ?? 'Failed to create the file')
    }
  }

  const chooseWorkspace = async (): Promise<void> => {
    const picked = await window.api?.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    const path = picked?.filePaths?.[0]
    if (!path) return
    const settings = (await window.api?.getSettings?.()) || {}
    const result = await window.api?.saveSettings?.({ ...settings, workspaceRoot: path })
    if (result?.success) {
      await initWorkspace()
    } else {
      setError('Failed to save the workspace folder')
    }
  }

  // Plain Ctrl+S saves the editor's current file from ANY surface — the
  // one deliberate exception to the rule that a CSS-hidden surface must
  // not answer global keys: the run-help write refusal tells the user
  // "save (Ctrl+S) and retry" while they sit on the chat surface, and a
  // dead key there bricks that loop. No conflicts: the chat composer
  // does not bind Ctrl+S, and a focused webview guest receives keys
  // before the host. The CodeMirror keymap preventDefaults the focused
  // case, so the defaultPrevented skip keeps a single save; Ctrl+Shift+S
  // (sidebar) is excluded by !shiftKey.
  useEffect(() => {
    const handleSaveKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
        if (event.defaultPrevented) return
        event.preventDefault()
        void saveCurrentFile()
      }
    }
    window.addEventListener('keydown', handleSaveKey)
    return () => window.removeEventListener('keydown', handleSaveKey)
  }, [saveCurrentFile])

  // Surface-level shortcuts, gated on the editor being visible (the
  // mounted-but-hidden editor must not intercept keystrokes on the chat
  // surface). Ctrl+F5 runs the current file (VS Code "Run Without
  // Debugging") through the trigger RunPanel registers. The markdown
  // preview shortcuts below stay markdown-only.
  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      // The ungated Ctrl+S listener runs first and preventDefaults: a
      // Ctrl+K → Ctrl+S sequence must not ALSO fire the chord's save-all
      // (same single-save outcome as before the split).
      if (event.defaultPrevented) return
      if (event.ctrlKey && event.key === 'F5') {
        event.preventDefault()
        void runTriggerRef.current?.()
        return
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: cycle the chat's artifacts sequentially
      // with wrap-around (no tabs/MRU here — the honest analog of VS Code's
      // Ctrl+PageUp/Down). Switching is loss-free: openFile restores drafts
      // from the store, so cycling never asks and never discards.
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const paths = files.map((file) => file.path)
        const next = nextArtifactPath(paths, currentFile, event.shiftKey)
        if (next) void openFile(next)
        return
      }
      // Ctrl+K chord arms for any file: Ctrl+K S saves all drafts of this
      // chat; the V completion below stays markdown-only.
      if (event.ctrlKey && event.key === 'k') {
        chordRef.current = true
        setTimeout(() => {
          chordRef.current = false
        }, 1000)
        return
      }
      if (chordRef.current && (event.key === 's' || event.key === 'S')) {
        event.preventDefault()
        chordRef.current = false
        void handleSaveAll()
        return
      }
      if (!isMarkdown(currentFile)) return
      if (event.ctrlKey && event.shiftKey && event.key === 'V') {
        event.preventDefault()
        setViewMode((mode) => (mode === 'preview' ? 'edit' : 'preview'))
        return
      }
      if (chordRef.current && event.key === 'v') {
        event.preventDefault()
        chordRef.current = false
        // A mode, not a tab: toggle like its sibling Ctrl+Shift+V.
        setViewMode((mode) => (mode === 'split' ? 'edit' : 'split'))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, currentFile, handleSaveAll, files, openFile])

  // Two-way scroll sync in split mode (ratio-based, loop-guarded).
  useEffect(() => {
    if (viewMode !== 'split') return
    const editorDOM = editorHandleRef.current?.getScrollDOM()
    const previewDOM = previewRef.current
    if (!editorDOM || !previewDOM) return

    const sync = (from: HTMLElement, to: HTMLElement): void => {
      if (scrollSyncingRef.current) return
      scrollSyncingRef.current = true
      const max = Math.max(from.scrollHeight - from.clientHeight, 1)
      to.scrollTop = (from.scrollTop / max) * Math.max(to.scrollHeight - to.clientHeight, 1)
      requestAnimationFrame(() => {
        scrollSyncingRef.current = false
      })
    }
    const fromEditor = (): void => sync(editorDOM, previewDOM)
    const fromPreview = (): void => sync(previewDOM, editorDOM)
    editorDOM.addEventListener('scroll', fromEditor)
    previewDOM.addEventListener('scroll', fromPreview)
    return () => {
      editorDOM.removeEventListener('scroll', fromEditor)
      previewDOM.removeEventListener('scroll', fromPreview)
    }
  }, [viewMode, currentFile])

  // --- workspace unset prompt ---
  if (workspaceState === 'unset') {
    return (
      <div className="editor-view">
        <div className="editor-placeholder">
          <div className="empty-icon">🗂️</div>
          <p>Choose a workspace folder to edit chat artifacts.</p>
          <p className="editor-placeholder-sub">
            Each chat keeps its files in a folder of its own under this directory.
          </p>
          <button className="btn-primary" onClick={() => void chooseWorkspace()}>
            Choose Folder…
          </button>
          <button className="btn-secondary" onClick={onClose}>
            ← Back to Chat
          </button>
        </div>
      </div>
    )
  }

  // --- chat picker (no chat selected) ---
  if (workspaceState === 'ready' && !activeChatId) {
    return (
      <div className="editor-view">
        <div className="editor-placeholder">
          <div className="empty-icon">📁</div>
          <p>Pick a chat directory to edit its artifacts.</p>
          {chatDirs.length === 0 ? (
            <p className="editor-placeholder-sub">
              No chat folders yet — open a chat&apos;s artifacts to create one.
            </p>
          ) : (
            <div className="chat-dir-list">
              {chatDirs.map((dir) => (
                <button
                  key={dir.id}
                  className="chat-dir-item"
                  onClick={() => {
                    setActiveChatId(dir.id)
                    // Keep App's editorChatId in sync, or its chat-switch
                    // draft guard cannot see this chat later.
                    onChatSelected?.(dir.id)
                  }}
                >
                  <span className="chat-dir-title">{dir.title}</span>
                  <span className="chat-dir-id">{dir.id}</span>
                  {dirtyCount(dir.id) > 0 && (
                    <span className="dirty-dot" title={`${dirtyCount(dir.id)} unsaved draft(s)`}>
                      ●
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <button className="btn-secondary" onClick={onClose}>
            ← Back to Chat
          </button>
        </div>
      </div>
    )
  }

  const markdownOpen = isMarkdown(currentFile)

  return (
    <div className="editor-view">
      <div className="editor-sidebar">
        <div className="editor-sidebar-header">
          <span>Artifacts</span>
          <div className="editor-sidebar-actions">
            <button title="New file" onClick={() => setNewFileName('')}>
              ＋
            </button>
            <button title="Refresh" onClick={() => void refreshFiles()}>
              🔄
            </button>
          </div>
        </div>
        {newFileName !== null && (
          <div className="new-file-row">
            <input
              autoFocus
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateFile()
                if (e.key === 'Escape') setNewFileName(null)
              }}
              placeholder="name.md or src/script.py"
              spellCheck={false}
            />
          </div>
        )}
        <div className="artifact-list">
          {files.length === 0 ? (
            <div className="artifact-empty">No files yet — create the first one.</div>
          ) : (
            files.map((file) => (
              <button
                key={file.path}
                className={`artifact-item${currentFile === file.path ? ' active' : ''}`}
                onClick={() => void openFile(file.path)}
                title={file.path}
              >
                {file.path}
                {activeChatId && hasDraft(activeChatId, file.path) && (
                  <span className="dirty-dot">●</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="editor-content">
        <div className="editor-toolbar">
          <button className="editor-back" onClick={onClose} title="Back to chat">
            ←
          </button>
          <span className="editor-filename">
            {currentFile ?? 'No file open'}
            {dirty && <span className="dirty-dot">●</span>}
          </span>
          {markdownOpen && (
            <div className="mode-toggle">
              <button
                className={viewMode === 'edit' ? 'active' : ''}
                onClick={() => setViewMode('edit')}
              >
                Edit
              </button>
              <button
                className={viewMode === 'split' ? 'active' : ''}
                onClick={() => setViewMode('split')}
                title="Ctrl+K V"
              >
                Split
              </button>
              <button
                className={viewMode === 'preview' ? 'active' : ''}
                onClick={() => setViewMode('preview')}
                title="Ctrl+Shift+V"
              >
                Preview
              </button>
            </div>
          )}
          <button
            className="editor-save"
            onClick={() => void saveCurrentFile()}
            disabled={!dirty}
            title="Ctrl+S"
          >
            Save
          </button>
        </div>

        {error && (
          <div className="editor-error">
            <span>⚠️ {error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {diskConflict && diskConflict.path === currentFile && (
          <div className="disk-conflict">
            <span>
              ⚠️ {diskConflict.path} changed on disk (AI assistant or an external program). Your
              unsaved draft differs.
            </span>
            <span className="disk-conflict-actions">
              <button onClick={() => void handleConflictLoadDisk()}>Load disk version</button>
              <button
                onClick={handleConflictKeepDraft}
                title="Keep editing your draft — a later save will overwrite the disk version"
              >
                Keep my draft
              </button>
            </span>
          </div>
        )}

        <div className="editor-body">
          {currentFile ? (
            <>
              <div
                className="editor-pane"
                style={{ display: viewMode === 'preview' ? 'none' : 'block' }}
              >
                <CodeEditor
                  ref={editorHandleRef}
                  value={fileContent}
                  fileName={currentFile}
                  onChange={(value) => {
                    setFileContent(value)
                    // Write-through: the draft store always holds the latest
                    // unsaved text, so any switch or remount restores it.
                    if (activeChatId && currentFile) {
                      setDraft(activeChatId, currentFile, value, savedContent)
                    }
                  }}
                  onSave={() => void saveCurrentFile()}
                />
              </div>
              {markdownOpen && viewMode !== 'edit' && (
                <div className="editor-pane preview-pane">
                  <MarkdownPreview source={fileContent} containerRef={previewRef} />
                </div>
              )}
            </>
          ) : (
            <div className="editor-placeholder">
              <p>Select an artifact on the left, or create a new file.</p>
            </div>
          )}
        </div>

        {activeChatId && (
          <RunPanel
            chatId={activeChatId}
            currentFile={currentFile}
            skillArmed={skillArmed}
            onToggleSkill={onToggleSkill}
            saveCurrentFile={saveCurrentFile}
            registerRun={registerRun}
            hasSession={hasSession}
            onAskAi={(input) => onAskAi({ ...input, chatId: activeChatId })}
          />
        )}
      </div>
    </div>
  )
}
