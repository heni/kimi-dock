// AI run-help: OpenAI-style tool definitions, dispatch and the agent loop.
// Pure (no Electron, no fs) — deps are injected, so unit tests compile this
// module with the project's tsc and run it under node:test. The main process
// wires the deps to the runner's last-run record and the workspace guard;
// the endpoint's tool-calling support is probe-confirmed (2026-11-25).

// The last run of a chat directory, retained by the proc-start tee in main.
export interface LastRun {
  command: string
  source?: string // 'builtin' | 'run-json' | 'free-form'
  exitCode: number | null
  signal: string | null
  stdoutTail: string
  stderrTail: string
  endedAt: number | null // null while the process is still running
}

export interface RunHelpDeps {
  getLastRun: () => LastRun | null
  readArtifact: (relPath: string) => string // must throw on escapes/missing
  listArtifacts: () => string[] // relative paths
  getRunJson: () => string | null
}

// OpenAI-style function tools (the shape the coding endpoint accepts).
export const RUN_HELP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_run_output',
      description:
        'Get the last run in this chat directory: the exact command and its source level, exit code and the tails of stdout/stderr.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_artifact',
      description:
        'Read a file from this chat directory (source code, config). Paths are relative to the chat directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_artifacts',
      description: 'List the files in this chat directory (relative paths).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_run_json',
      description: 'Get the content of run.json in this chat directory, or null if there is none.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
] as const

const ARTIFACT_MAX_CHARS = 16 * 1024
const TOOL_RESULT_MAX_CHARS = 32 * 1024
const LIST_MAX_ENTRIES = 200

const cap = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n… [truncated, ${text.length} chars total]` : text

// Tool errors are returned as JSON content, never thrown: the model reads
// them and can correct itself (wrong path, no runs yet).
export function dispatchRunHelpTool(
  deps: RunHelpDeps,
  name: unknown,
  argsJson: unknown
): string {
  let args: Record<string, unknown> = {}
  if (typeof argsJson === 'string' && argsJson.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(argsJson)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      return JSON.stringify({ error: 'Arguments are not valid JSON' })
    }
  }

  try {
    switch (name) {
      case 'get_run_output': {
        const run = deps.getLastRun()
        if (!run) return JSON.stringify({ error: 'No runs recorded in this chat yet' })
        return cap(
          JSON.stringify({
            command: run.command,
            source: run.source ?? 'unknown',
            exitCode: run.exitCode,
            signal: run.signal,
            running: run.endedAt === null,
            stdoutTail: run.stdoutTail,
            stderrTail: run.stderrTail
          }),
          TOOL_RESULT_MAX_CHARS
        )
      }
      case 'read_artifact': {
        if (typeof args.path !== 'string' || args.path.length === 0) {
          return JSON.stringify({ error: 'path must be a non-empty string' })
        }
        return cap(deps.readArtifact(args.path), ARTIFACT_MAX_CHARS)
      }
      case 'list_artifacts': {
        const files = deps.listArtifacts()
        return JSON.stringify({
          files: files.slice(0, LIST_MAX_ENTRIES),
          truncated: files.length > LIST_MAX_ENTRIES
        })
      }
      case 'get_run_json': {
        return JSON.stringify({ content: deps.getRunJson() })
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${String(name)}` })
    }
  } catch (error) {
    return JSON.stringify({ error: (error as Error).message })
  }
}

// --- agent loop --------------------------------------------------------------

export type ChatFn = (body: Record<string, unknown>) => Promise<{
  ok: boolean
  status?: number
  data?: {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown }
      finish_reason?: unknown
    }>
  }
  error?: string
}>

// The response shape chatOnce hands to the loop (and the proxy hands to the
// renderer verbatim).
export type ChatResponse = {
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: unknown }
    finish_reason?: unknown
  }>
  error?: { message?: string }
}

const MAX_ITERATIONS = 6

interface ToolCall {
  id: string
  function?: { name?: unknown; arguments?: unknown }
}

// One run-help request: chat with tools until the model answers with plain
// content. Throws on API errors and on the iteration cap — the caller
// (serial queue) surfaces that as an ordinary send failure.
export async function runHelpLoop(
  chat: ChatFn,
  deps: RunHelpDeps,
  model: string,
  messages: unknown[]
): Promise<string> {
  const convo: unknown[] = [...messages]
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const res = await chat({ model, messages: convo, tools: RUN_HELP_TOOLS })
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status ?? '?'}`)
    const message = res.data?.choices?.[0]?.message
    const toolCalls = message?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      convo.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls })
      for (const call of toolCalls as ToolCall[]) {
        if (typeof call?.id !== 'string') throw new Error('Malformed tool call (no id)')
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: dispatchRunHelpTool(deps, call.function?.name, call.function?.arguments)
        })
      }
      continue
    }
    if (typeof message?.content === 'string') return message.content
    throw new Error('Unexpected API response')
  }
  throw new Error(`Run-help did not converge in ${MAX_ITERATIONS} tool iterations`)
}
