// AI run-help: the trigger message the ✨ Ask AI button puts into the chat.
// Pure — unit tests compile this module with the project's tsc and run it
// under node:test. The text is human-readable and stays in the history as
// the record of what was asked (the model pulls the details itself via the
// run-help tools); the wording follows the approved design doc.

// The .js extension is deliberate: the unit-test build runs the compiled
// output under Node ESM, which requires explicit extensions (vite and tsc
// resolve it to the .ts source).
import { dirtyPaths, getDraft } from './draftStore.js'

export interface RunHelpTriggerInput {
  file: string // relative path inside the chat directory
  command: string
  source: 'builtin' | 'run-json' | 'free-form'
  exitCode: number | null // null: no run yet, or killed by a signal
  signal: string | null
  running?: boolean // a run is in flight right now
  fileDirty?: boolean // the file has unsaved editor changes right now
}

const COMMAND_MAX_CHARS = 300

const SOURCE_LABELS: Record<RunHelpTriggerInput['source'], string> = {
  builtin: 'built-in',
  'run-json': 'run.json',
  'free-form': 'free-form'
}

const capCommand = (command: string): string =>
  command.length > COMMAND_MAX_CHARS ? `${command.slice(0, COMMAND_MAX_CHARS)}…` : command

export function buildRunHelpTrigger(input: RunHelpTriggerInput): string {
  const command = `\`${capCommand(input.command)}\``
  const source = `(${SOURCE_LABELS[input.source]})`
  // The dirty flag grounds the first answer: the model must analyze the
  // buffer, not yesterday's disk (read_artifact returns the buffer).
  const dirty = input.fileDirty
    ? ' Файл сейчас имеет несохранённые изменения в редакторе — read_artifact вернёт актуальный буфер, а не диск.'
    : ''
  if (input.exitCode === 0) {
    return `Объясни, что делает программа в \`${input.file}\`. Последний запуск: exit 0, команда ${source}: ${command}${dirty}`
  }
  const outcome = input.running
    ? 'запущен и ещё выполняется'
    : input.exitCode !== null
      ? `exit ${input.exitCode}`
      : input.signal !== null
        ? `killed (${input.signal})`
        : 'запуск ещё не выполнялся'
  return `Разберись с последним запуском \`${input.file}\`: ${outcome}, команда ${source}: ${command}${dirty}`
}

// The ✨ trigger for a chat with NO file open yet (an empty chat): the
// button still works — it arms the conversation (the run-help marker is
// sticky) and tells the model the directory appears on the first write.
// The user states the actual wish in the next message. The wording is
// neutral about which directory the tools see (Alt+click asks in a
// fresh conversation but keeps the tools on the opened chat).
export function buildFirstArtifactTrigger(): string {
  return 'Если в рабочей директории чата ещё нет файлов — создай первый по моей следующей просьбе (write_artifact создаст директорию автоматически). Начни с list_artifacts, чтобы увидеть текущее состояние.'
}

// --- unsaved buffers pushed with the request ---------------------------------

// Caps on the buffer push — the same limits main enforces when parsing the
// payload (RUN_HELP_BUFFER_* in src/main/index.ts); keep in sync. A draft
// over the cap is skipped: that file's reads degrade to disk instead of
// bricking the whole pass.
export const RUN_HELP_BUFFER_MAX_ENTRIES = 64
export const RUN_HELP_BUFFER_MAX_CHARS = 64 * 1024

// The chat's unsaved editor drafts as { path: content }, sent at stream
// start so the run-help tools read the live buffers instead of the stale
// disk. Freshness is per pass: the next send pushes a new snapshot.
export function collectRunHelpBuffers(chatId: string): Record<string, string> {
  const buffers: Record<string, string> = {}
  let count = 0
  for (const path of dirtyPaths(chatId)) {
    if (count >= RUN_HELP_BUFFER_MAX_ENTRIES) break
    const draft = getDraft(chatId, path)
    if (!draft || draft.content.length > RUN_HELP_BUFFER_MAX_CHARS) continue
    buffers[path] = draft.content
    count += 1
  }
  return buffers
}

// --- which run the trigger describes -----------------------------------------

export interface RunExit {
  code: number | null
  signal: string | null
  file: string | null
  command: string
  source: RunHelpTriggerInput['source']
}

export interface RunHelpContextInput {
  running: boolean
  runningFile: string | null // the file the in-flight run started for
  runningCtx: { command: string; source: RunHelpTriggerInput['source'] }
  lastExit: RunExit | null
  currentFile: string | null
  currentCommand: string
  currentSource: RunHelpTriggerInput['source']
}

export interface RunHelpContext {
  command: string
  source: RunHelpTriggerInput['source']
  exitCode: number | null
  signal: string | null
  running: boolean
}

// The trigger describes the run when one exists FOR THIS FILE: mid-run →
// the running command/source (an in-flight run has no exit yet, whatever
// the previous one was); exited → the run's own tags (a post-run edit must
// not rewrite what ran); no run for this file → the current line. A run
// in flight for ANOTHER file does not leak into this file's trigger.
export function selectRunHelpContext(input: RunHelpContextInput): RunHelpContext {
  if (input.running && input.runningFile === input.currentFile) {
    return {
      command: input.runningCtx.command,
      source: input.runningCtx.source,
      exitCode: null,
      signal: null,
      running: true
    }
  }
  const exitForFile =
    input.lastExit && input.lastExit.file === input.currentFile ? input.lastExit : null
  if (exitForFile) {
    return {
      command: exitForFile.command,
      source: exitForFile.source,
      exitCode: exitForFile.code,
      signal: exitForFile.signal,
      running: false
    }
  }
  return {
    command: input.currentCommand,
    source: input.currentSource,
    exitCode: null,
    signal: null,
    running: false
  }
}
