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
