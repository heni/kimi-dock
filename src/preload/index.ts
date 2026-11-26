import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// Expose secure API to renderer
contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: (): void => ipcRenderer.send('minimize'),
  maximize: (): void => ipcRenderer.send('maximize'),
  close: (): void => ipcRenderer.send('close'),
  restartApp: (): void => ipcRenderer.send('restart-app'),

  // Window state
  onMaximizeChange: (callback: (value: boolean) => void): (() => void) => {
    const listener: (event: IpcRendererEvent, value: boolean) => void = (_, value) =>
      callback(value)
    ipcRenderer.on('window-maximized', listener)
    return () => ipcRenderer.removeListener('window-maximized', listener)
  },

  // Navigation (for deep linking)
  onNavigateTo: (callback: (path: string) => void): (() => void) => {
    const listener: (event: IpcRendererEvent, path: string) => void = (_, path) => callback(path)
    ipcRenderer.on('navigate-to', listener)
    return () => ipcRenderer.removeListener('navigate-to', listener)
  },

  // Auth popup finished (identity provider redirected back to the app origin)
  onAuthPopupFinished: (callback: () => void): (() => void) => {
    const listener: () => void = () => callback()
    ipcRenderer.on('auth-popup-finished', listener)
    return () => ipcRenderer.removeListener('auth-popup-finished', listener)
  },

  // Open settings
  onOpenSettings: (callback: () => void): (() => void) => {
    const listener: () => void = () => callback()
    ipcRenderer.on('open-settings', listener)
    return () => ipcRenderer.removeListener('open-settings', listener)
  },

  // App info
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('check-for-updates'),

  // File dialogs
  showSaveDialog: (options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> =>
    ipcRenderer.invoke('show-save-dialog', options),
  showOpenDialog: (options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> =>
    ipcRenderer.invoke('show-open-dialog', options),

  // Settings management
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: unknown): Promise<unknown> =>
    ipcRenderer.invoke('save-settings', settings),
  onSettingsChanged: (callback: (settings: unknown) => void): (() => void) => {
    const listener: (event: IpcRendererEvent, settings: unknown) => void = (_, settings) =>
      callback(settings)
    ipcRenderer.on('settings-changed', listener)
    return () => ipcRenderer.removeListener('settings-changed', listener)
  },

  // Data clearing
  clearData: (type: string): Promise<unknown> => ipcRenderer.invoke('clear-data', type),

  // Conversation management
  exportConversations: (): Promise<unknown> => ipcRenderer.invoke('export-conversations'),
  importConversations: (data: unknown): Promise<unknown> =>
    ipcRenderer.invoke('import-conversations', data),

  // Streaming chat completions: the receive half of the offline chat's send
  // queue. Main forces stream:true and forwards content deltas as events.
  // runHelp switches main to the tool-calling agent loop for that chat;
  // buffers carries the chat's unsaved editor drafts for this pass.
  kimiApiStreamStart: (payload: {
    requestId: string
    body: Record<string, unknown>
    runHelp?: { chatId: string; buffers?: Record<string, string> }
  }): Promise<{ success: boolean; error?: string; code?: string }> =>
    ipcRenderer.invoke('kimi-api-stream-start', payload),
  kimiApiStreamAbort: (requestId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('kimi-api-stream-abort', { requestId }),
  onKimiApiStreamEvent: (
    callback: (
      event:
        | { requestId: string; type: 'delta'; content: string }
        | { requestId: string; type: 'done'; aborted: boolean; dispatched?: boolean }
        | { requestId: string; type: 'error'; message: string }
    ) => void
  ): (() => void) => {
    const listener = (_: IpcRendererEvent, event: unknown): void => callback(event as never)
    ipcRenderer.on('kimi-api-stream-event', listener)
    return () => ipcRenderer.removeListener('kimi-api-stream-event', listener)
  },
  // A run-help write_artifact landed on disk in a chat directory.
  onRunHelpArtifactWritten: (
    callback: (payload: { chatId: string; path: string }) => void
  ): (() => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown): void =>
      callback(payload as { chatId: string; path: string })
    ipcRenderer.on('run-help-artifact-written', listener)
    return () => ipcRenderer.removeListener('run-help-artifact-written', listener)
  },

  // Kimi Code OAuth (Device Authorization Grant)
  oauthStatus: (): Promise<{
    loggedIn: boolean
    expiresAt?: number
    models: Array<{ id: string; display_name: string | null; context_length: number }>
    selectedModel: string | null
  }> => ipcRenderer.invoke('kimi-oauth-status'),
  oauthLogin: (): Promise<{ started: boolean }> => ipcRenderer.invoke('kimi-oauth-login'),
  oauthCancel: (): Promise<{ success: boolean }> => ipcRenderer.invoke('kimi-oauth-cancel'),
  oauthLogout: (): Promise<{ success: boolean }> => ipcRenderer.invoke('kimi-oauth-logout'),
  oauthSelectModel: (modelId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('kimi-oauth-select-model', modelId),
  onOAuthEvent: (
    callback: (event: {
      type: 'verification_url' | 'waiting' | 'success' | 'error'
      message: string
      data?: Record<string, unknown>
    }) => void
  ): (() => void) => {
    const listener = (_: IpcRendererEvent, event: unknown): void => callback(event as never)
    ipcRenderer.on('kimi-oauth-event', listener)
    return () => ipcRenderer.removeListener('kimi-oauth-event', listener)
  },

  // Notifications
  showNotification: (options: Electron.NotificationConstructorOptions): Promise<unknown> =>
    ipcRenderer.invoke('show-notification', options),

  // Developer tools
  openDevTools: (): void => ipcRenderer.send('open-dev-tools'),

  // Network status (renderer can use navigator.onLine, but this is for consistency)
  isOnline: (): boolean => navigator.onLine,

  // Clipboard bridge (Electron clipboard lives in the main process; the
  // sandboxed renderer has no direct access). 'rich-text' returns paste-ready
  // HTML (native clipboard HTML, or RTF converted to a fragment).
  clipboardRead: (
    format: 'text' | 'html' | 'rich-text' | 'image'
  ): Promise<{ success: boolean; value?: string | null; error?: string }> =>
    ipcRenderer.invoke('clipboard-read', format),
  clipboardWrite: (
    format: 'text' | 'html' | 'image',
    value: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('clipboard-write', format, value),

  // Workspace FS gateway (paths are relative to the workspace root; main
  // normalizes and refuses escapes)
  fsList: (relDir: string): Promise<{ success: boolean; entries?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('fs-list', relDir),
  fsListRecursive: (
    relDir: string
  ): Promise<{ success: boolean; files?: unknown[]; error?: string }> =>
    ipcRenderer.invoke('fs-list-recursive', relDir),
  fsRead: (relPath: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('fs-read', relPath),
  fsWrite: (relPath: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs-write', relPath, content),

  // Run console (tier 1): command resolution (built-in table + run.json) and
  // process lifecycle; output/exit arrive as events
  procResolve: (
    chatId: string,
    relPath: string
  ): Promise<{ success: boolean; resolved?: unknown; runJsonError?: string; error?: string }> =>
    ipcRenderer.invoke('proc-resolve', chatId, relPath),
  procStart: (payload: {
    chatId: string
    command: string
    source?: string
    env?: Record<string, string>
    cwd?: string
    timeoutSec?: number
  }): Promise<{ success: boolean; id?: string; error?: string }> =>
    ipcRenderer.invoke('proc-start', payload),
  procStop: (id: string): Promise<{ success: boolean }> => ipcRenderer.invoke('proc-stop', id),
  // Fire-and-forget mirror of the draft store's dirty count; main's
  // app-exit dialog gates on it.
  setDraftCount: (count: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('drafts-set-count', count),
  onProcOutput: (
    callback: (event: { id: string; stream: 'stdout' | 'stderr'; data: string }) => void
  ): (() => void) => {
    const listener = (_: IpcRendererEvent, event: unknown): void => callback(event as never)
    ipcRenderer.on('proc-output', listener)
    return () => ipcRenderer.removeListener('proc-output', listener)
  },
  onProcExit: (
    callback: (event: { id: string; code: number | null; signal: string | null }) => void
  ): (() => void) => {
    const listener = (_: IpcRendererEvent, event: unknown): void => callback(event as never)
    ipcRenderer.on('proc-exit', listener)
    return () => ipcRenderer.removeListener('proc-exit', listener)
  }
})

// Expose electron versions (safe info)
contextBridge.exposeInMainWorld('electron', {
  process: {
    versions: {
      chrome: process.versions.chrome,
      node: process.versions.node,
      electron: process.versions.electron
    }
  }
})

// Log that preload script loaded successfully
console.log('[Preload] Script loaded successfully')
