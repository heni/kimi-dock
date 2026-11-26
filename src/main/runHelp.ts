// AI run-help: OpenAI-style tool definitions, dispatch and the agent loop.
// Pure (no Electron, no fs, no fetch) — deps and the streaming round
// function are injected, so unit tests compile this module with the
// project's tsc and run it under node:test. The main process wires the
// deps to the runner's last-run record and the workspace guard; the
// endpoint's tool-calling and streaming support is probe-confirmed
// (2026-11-25 / 2026-11-26).

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

// What read_artifact saw. The source matters: an unsaved editor buffer is
// the user's current truth, the disk may lag it. mtimeMs is null for a
// buffer (it has no on-disk time).
export interface ArtifactRead {
  content: string
  source: 'disk' | 'editor-buffer'
  sizeBytes: number
  mtimeMs: number | null
}

export interface RunHelpDeps {
  getLastRun: () => LastRun | null
  // Must throw on escapes/missing. A path with an unsaved editor buffer
  // resolves to the buffer, not the disk.
  readArtifact: (relPath: string) => ArtifactRead
  listArtifacts: () => string[] // relative paths
  // Relative paths with an unsaved editor buffer right now (pushed by the
  // renderer at stream start).
  unsavedBuffers: () => string[]
  // Full-file create/overwrite inside the chat directory. Must throw on
  // escapes and on files with unsaved editor buffers (the refusal text is
  // model-facing: it says to ask the user to save first). Returns the
  // written byte count.
  writeArtifact: (relPath: string, content: string) => { bytes: number }
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
        'Read a file from this chat directory (source code, config). Paths are relative to the chat directory. The result starts with a header line naming the source — "on disk" or "unsaved editor buffer" — with the byte size and modification time; an unsaved buffer is the user\'s current truth when it differs from disk.',
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
      name: 'write_artifact',
      description:
        "Write a file in this chat directory: full content, creates or overwrites. Confined to the chat directory. Refused while the file has unsaved changes in the user's editor — then ask the user to save (Ctrl+S) or discard them, and retry.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Full new file content' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_artifacts',
      description:
        'List the files in this chat directory (relative paths), plus which of them have unsaved editor buffers.',
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
const WRITE_MAX_CHARS = 32 * 1024
const TOOL_RESULT_MAX_CHARS = 32 * 1024
const LIST_MAX_ENTRIES = 200

const cap = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n… [truncated, ${text.length} chars total]` : text

// Grounding for the model's claims about what it sees: the header, not its
// own arithmetic, is where byte counts and freshness come from.
const readHeader = (path: string, read: ArtifactRead): string => {
  if (read.source === 'editor-buffer') {
    return `[${path} — unsaved editor buffer, ${read.sizeBytes} bytes]`
  }
  const modified = read.mtimeMs !== null ? `, modified ${new Date(read.mtimeMs).toISOString()}` : ''
  return `[${path} — on disk, ${read.sizeBytes} bytes${modified}]`
}

// Tool errors are returned as JSON content, never thrown: the model reads
// them and can correct itself (wrong path, no runs yet).
export function dispatchRunHelpTool(deps: RunHelpDeps, name: unknown, argsJson: unknown): string {
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
        const read = deps.readArtifact(args.path)
        return `${readHeader(args.path, read)}\n${cap(read.content, ARTIFACT_MAX_CHARS)}`
      }
      case 'write_artifact': {
        if (typeof args.path !== 'string' || args.path.length === 0) {
          return JSON.stringify({ error: 'path must be a non-empty string' })
        }
        if (typeof args.content !== 'string') {
          return JSON.stringify({ error: 'content must be a string' })
        }
        if (args.content.length > WRITE_MAX_CHARS) {
          return JSON.stringify({
            error: `content too large (${args.content.length} chars, cap ${WRITE_MAX_CHARS})`
          })
        }
        const result = deps.writeArtifact(args.path, args.content)
        return JSON.stringify({ written: true, path: args.path, bytes: result.bytes })
      }
      case 'list_artifacts': {
        const files = deps.listArtifacts()
        return cap(
          JSON.stringify({
            files: files.slice(0, LIST_MAX_ENTRIES),
            truncated: files.length > LIST_MAX_ENTRIES,
            unsavedBuffers: deps.unsavedBuffers()
          }),
          TOOL_RESULT_MAX_CHARS
        )
      }
      case 'get_run_json': {
        return cap(JSON.stringify({ content: deps.getRunJson() }), TOOL_RESULT_MAX_CHARS)
      }
      default:
        return cap(
          JSON.stringify({ error: `Unknown tool: ${String(name)}` }),
          TOOL_RESULT_MAX_CHARS
        )
    }
  } catch (error) {
    return cap(JSON.stringify({ error: (error as Error).message }), TOOL_RESULT_MAX_CHARS)
  }
}

// --- streamed tool_calls assembly -------------------------------------------

export interface AssembledToolCall {
  id: string
  name: string
  arguments: string
}

// Assemble streamed tool_calls deltas (the probed wire shape: a call's
// first fragment carries id + function.name, later fragments append
// function.arguments, all keyed by index). Malformed entries are skipped;
// a call left without an id is rejected by the loop.
export function assembleToolCalls(deltas: unknown[]): AssembledToolCall[] {
  const byIndex = new Map<number, AssembledToolCall>()
  for (const raw of deltas) {
    if (raw === null || typeof raw !== 'object') continue
    const delta = raw as Record<string, unknown>
    const index = typeof delta.index === 'number' ? delta.index : 0
    const fn = (
      delta.function !== null && typeof delta.function === 'object' ? delta.function : {}
    ) as Record<string, unknown>
    let call = byIndex.get(index)
    if (!call) {
      call = { id: '', name: '', arguments: '' }
      byIndex.set(index, call)
    }
    if (typeof delta.id === 'string') call.id = delta.id
    if (typeof fn.name === 'string') call.name = fn.name
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
}

// --- agent loop --------------------------------------------------------------

// One streamed round as the main process runs it: content deltas are
// forwarded to the renderer live inside the round; the loop sees only the
// assembled outcome.
export interface StreamedRound {
  content: string
  toolCalls: AssembledToolCall[]
  finishReason: string | null
}

export type StreamRoundFn = (body: Record<string, unknown>) => Promise<StreamedRound>

const MAX_ITERATIONS = 6

// The run-help agent loop over streamed rounds: a round with tool calls
// appends the assistant message and the dispatched role:tool results and
// continues; a content round ends the loop. Throws on API errors (the
// round function propagates them) and on the iteration cap — the caller
// surfaces both as an ordinary send failure.
export async function runHelpLoop(
  streamRound: StreamRoundFn,
  deps: RunHelpDeps,
  model: string,
  messages: unknown[]
): Promise<string> {
  const convo: unknown[] = [...messages]
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // A snapshot per round: the round function is async, and the loop's
    // later appends must not leak into an in-flight request's body.
    const round = await streamRound({ model, messages: [...convo], tools: RUN_HELP_TOOLS })
    if (round.toolCalls.length > 0) {
      convo.push({
        role: 'assistant',
        content: round.content.length > 0 ? round.content : null,
        tool_calls: round.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      })
      for (const call of round.toolCalls) {
        if (call.id.length === 0) throw new Error('Malformed tool call (no id)')
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: dispatchRunHelpTool(deps, call.name, call.arguments)
        })
      }
      continue
    }
    return round.content
  }
  throw new Error(`Run-help did not converge in ${MAX_ITERATIONS} tool iterations`)
}
