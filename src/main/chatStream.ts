// SSE parsing and stream-event classification for the offline chat's
// streaming replies. Pure (no Electron, no fetch) — unit tests compile this
// module with the project's tsc and run it under node:test. The endpoint's
// stream shape is probe-confirmed (2026-11-26): `data:` events, a `[DONE]`
// terminator, content in small deltas, reasoning in a separate
// `reasoning_content` field, tool calls as indexed `tool_calls` deltas.

export interface SseEvent {
  data: string
}

export interface SseParser {
  // Feed decoded text; complete events dispatch on blank lines. An
  // incomplete trailing line waits in the buffer for the next feed.
  feed: (text: string) => SseEvent[]
  // Flush at stream end: a trailing event whose blank line never arrived.
  end: () => SseEvent[]
}

export function createSseParser(): SseParser {
  let buffer = ''
  let dataLines: string[] = []

  const processLine = (line: string, events: SseEvent[]): void => {
    if (line === '') {
      if (dataLines.length > 0) {
        events.push({ data: dataLines.join('\n') })
        dataLines = []
      }
      return
    }
    // Keep-alive comments (": ping") and the event:/id:/retry: fields carry
    // nothing the chat stream needs.
    if (!line.startsWith('data:')) return
    // The spec strips exactly one leading space after "data:".
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  return {
    feed(text: string): SseEvent[] {
      buffer += text
      const events: SseEvent[] = []
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        processLine(raw.replace(/\r$/, ''), events)
      }
      return events
    },
    end(): SseEvent[] {
      const events: SseEvent[] = []
      if (buffer.length > 0) {
        processLine(buffer.replace(/\r$/, ''), events)
        buffer = ''
      }
      processLine('', events)
      return events
    }
  }
}

export type ClassifiedStreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning' }
  | { kind: 'toolCalls'; calls: unknown[]; content?: string }
  | { kind: 'finish'; reason: string | null }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' }

// Classify one SSE data payload. Content is checked before finish so a
// delta carrying both loses nothing; an empty content string (the role-only
// first delta) is noise, not text.
export function classifyStreamEvent(data: string): ClassifiedStreamEvent {
  if (data === '[DONE]') return { kind: 'done' }
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return { kind: 'ignore' }
  }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'ignore' }
  const record = parsed as Record<string, unknown>

  const error = record.error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    return { kind: 'error', message: typeof message === 'string' ? message : 'Stream error' }
  }

  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return { kind: 'ignore' }
  const choice = choices[0]
  if (choice === null || typeof choice !== 'object') return { kind: 'ignore' }
  const delta = ((choice as Record<string, unknown>).delta ?? {}) as Record<string, unknown>

  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    // A delta may carry both content and tool_calls: classify as toolCalls
    // but keep the content, so neither is silently dropped.
    return {
      kind: 'toolCalls',
      calls: delta.tool_calls,
      ...(typeof delta.content === 'string' && delta.content.length > 0
        ? { content: delta.content }
        : {})
    }
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    return { kind: 'content', text: delta.content }
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    return { kind: 'reasoning' }
  }
  if (typeof choice.finish_reason === 'string') {
    return { kind: 'finish', reason: choice.finish_reason }
  }
  return { kind: 'ignore' }
}
