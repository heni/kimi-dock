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
  resolveSave,
  saveAllDrafts
} from '../utils/draftStore'
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
  onChatSelected
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
  const [savedContent, setSavedContent] = useState('')
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
        setFileContent(result.content)
        setSavedContent(result.content)
        setError(null)
        if (!isMarkdown(path)) setViewMode('edit')
      } else {
        setError(result?.error ?? 'Failed to open the file')
      }
    },
    [activeChatId]
  )

  const saveCurrentFile = useCallback(async (): Promise<boolean> => {
    if (!activeChatId || !currentFile) return false
    const path = currentFile
    const written = fileContent
    const result = await window.api?.fsWrite(`${activeChatId}/${path}`, written)
    if (result?.success) {
      // The user may have switched files during the write: the baseline of
      // whatever is open NOW must not be touched then.
      if (currentFileRef.current === path) setSavedContent(written)
      // A keystroke that raced the write survives, re-based onto disk.
      resolveSave(activeChatId, path, written)
      setError(null)
      return true
    }
    setError(result?.error ?? 'Failed to save the file')
    return false
  }, [activeChatId, currentFile, fileContent])

  // Ctrl+K S: save every dirty draft of THIS chat (other chats are never
  // touched). Failures keep their drafts and are reported; the current
  // file's baseline advances only if its own write landed.
  const handleSaveAll = useCallback(async (): Promise<void> => {
    if (!activeChatId) return
    const fileAtStart = currentFile
    const { failed } = await saveAllDrafts(activeChatId)
    if (
      fileAtStart &&
      currentFileRef.current === fileAtStart &&
      !hasDraft(activeChatId, fileAtStart)
    ) {
      setSavedContent(fileContent)
    }
    setError(failed > 0 ? `Failed to save ${failed} draft${failed === 1 ? '' : 's'}` : null)
  }, [activeChatId, currentFile, fileContent])

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

  // Surface-level shortcuts, gated on the editor being visible (the
  // mounted-but-hidden editor must not intercept keystrokes on the chat
  // surface). Ctrl+S saves from any focus — the CodeMirror keymap handles
  // the focused case and preventDefaults it, so defaultPrevented skips the
  // double save; Ctrl+Shift+S (sidebar) is excluded by !shiftKey. Ctrl+F5
  // runs the current file (VS Code "Run Without Debugging") through the
  // trigger RunPanel registers. The markdown preview shortcuts below stay
  // markdown-only.
  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
        if (event.defaultPrevented) return
        event.preventDefault()
        void saveCurrentFile()
        return
      }
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
        if (files.length === 0) return
        const paths = files.map((file) => file.path)
        const idx = currentFile ? paths.indexOf(currentFile) : -1
        // idx -1 (no file open, or it vanished): forward opens the first
        // artifact, backward the last.
        const next = event.shiftKey
          ? paths[idx <= 0 ? paths.length - 1 : idx - 1]
          : paths[(idx + 1) % paths.length]
        if (next && next !== currentFile) void openFile(next)
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
        setViewMode('split')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, currentFile, saveCurrentFile, handleSaveAll, files, openFile])

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
          />
        )}
      </div>
    </div>
  )
}
