// AI run-help: the trigger message the ✨ Ask AI button puts into the chat.
// Pure — unit tests compile this module with the project's tsc and run it
// under node:test. The text is human-readable and stays in the history as
// the record of what was asked (the model pulls the details itself via the
// run-help tools); the wording follows the approved design doc.

export interface RunHelpTriggerInput {
  file: string // relative path inside the chat directory
  command: string
  source: 'builtin' | 'run-json' | 'free-form'
  exitCode: number | null // null: no run yet, or killed by a signal
  signal: string | null
  running?: boolean // a run is in flight right now
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
  if (input.exitCode === 0) {
    return `Объясни, что делает программа в \`${input.file}\`. Последний запуск: exit 0, команда ${source}: ${command}`
  }
  const outcome = input.running
    ? 'запущен и ещё выполняется'
    : input.exitCode !== null
      ? `exit ${input.exitCode}`
      : input.signal !== null
        ? `killed (${input.signal})`
        : 'запуск ещё не выполнялся'
  return `Разберись с последним запуском \`${input.file}\`: ${outcome}, команда ${source}: ${command}`
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

// The trigger describes the run when one exists: mid-run → the running
// command/source (an in-flight run has no exit yet, whatever the previous
// one was); exited → the run's own tags (a post-run edit must not rewrite
// what ran); no run for this file → the current line.
export function selectRunHelpContext(input: RunHelpContextInput): RunHelpContext {
  if (input.running) {
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
