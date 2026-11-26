/*
 * Unit tests for the AI run-help core: tool dispatch, streamed tool_calls
 * assembly and the agent loop (src/main/runHelp.ts).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchRunHelpTool,
  assembleToolCalls,
  runHelpLoop,
  RUN_HELP_TOOLS
} from '../.tmp/unit-build/main/runHelp.js'

const deps = (overrides = {}) => ({
  getLastRun: () => null,
  readArtifact: (relPath) => {
    throw new Error(`escape refused: ${relPath}`)
  },
  listArtifacts: () => [],
  unsavedBuffers: () => [],
  writeArtifact: (relPath) => {
    throw new Error(`write refused: ${relPath}`)
  },
  getRunJson: () => null,
  ...overrides
})

const diskRead = (content) => ({
  content,
  source: 'disk',
  sizeBytes: Buffer.byteLength(content, 'utf8'),
  mtimeMs: 1700000000000
})

const bufferRead = (content) => ({
  content,
  source: 'editor-buffer',
  sizeBytes: Buffer.byteLength(content, 'utf8'),
  mtimeMs: null
})

// --- dispatchRunHelpTool ---

test('get_run_output reports no runs yet as JSON content, not a throw', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'get_run_output', '{}'))
  assert.match(result.error, /No runs recorded/)
})

test('get_run_output returns the last run with capped tails', () => {
  const run = {
    command: 'go run src/test.go',
    source: 'builtin',
    exitCode: 1,
    signal: null,
    stdoutTail: 'out',
    stderrTail: 'go: go.mod file not found',
    endedAt: 123
  }
  const result = JSON.parse(
    dispatchRunHelpTool(deps({ getLastRun: () => run }), 'get_run_output', '{}')
  )
  assert.equal(result.command, 'go run src/test.go')
  assert.equal(result.source, 'builtin')
  assert.equal(result.exitCode, 1)
  assert.equal(result.running, false)
  assert.equal(result.stderrTail, 'go: go.mod file not found')
})

test('get_run_output reports a still-running process', () => {
  const run = {
    command: 'npm start',
    exitCode: null,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
    endedAt: null
  }
  const result = JSON.parse(
    dispatchRunHelpTool(deps({ getLastRun: () => run }), 'get_run_output', '{}')
  )
  assert.equal(result.running, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.source, 'unknown')
})

test('non-string arguments are ignored (empty args)', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'get_run_output', 42))
  assert.match(result.error, /No runs recorded/)
})

test('read_artifact refuses a missing path argument', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'read_artifact', '{}'))
  assert.match(result.error, /path must be a non-empty string/)
})

test('read_artifact returns dep errors (escapes) as JSON content', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'read_artifact', '{"path":"../x"}'))
  assert.match(result.error, /escape refused/)
})

test('read_artifact caps oversized files', () => {
  const big = 'x'.repeat(20 * 1024)
  const result = dispatchRunHelpTool(
    deps({ readArtifact: () => diskRead(big) }),
    'read_artifact',
    '{"path":"a.txt"}'
  )
  assert.ok(result.length < 17.5 * 1024)
  assert.match(result, /truncated, 20480 chars total/)
})

test('list_artifacts caps the entry count', () => {
  const many = Array.from({ length: 250 }, (_, i) => `f${i}.txt`)
  const result = JSON.parse(
    dispatchRunHelpTool(deps({ listArtifacts: () => many }), 'list_artifacts', '{}')
  )
  assert.equal(result.files.length, 200)
  assert.equal(result.truncated, true)
})

test('list_artifacts caps the total result size', () => {
  const deep = Array.from({ length: 200 }, (_, i) => `${'d'.repeat(200)}/f${i}.txt`)
  const result = dispatchRunHelpTool(deps({ listArtifacts: () => deep }), 'list_artifacts', '{}')
  assert.ok(result.length <= 33 * 1024)
  assert.match(result, /truncated/)
})

test('list_artifacts reports which files have unsaved buffers', () => {
  const result = JSON.parse(
    dispatchRunHelpTool(
      deps({ listArtifacts: () => ['a.txt', 'b.txt'], unsavedBuffers: () => ['b.txt'] }),
      'list_artifacts',
      '{}'
    )
  )
  assert.deepEqual(result.files, ['a.txt', 'b.txt'])
  assert.deepEqual(result.unsavedBuffers, ['b.txt'])
})

test('read_artifact returns the content under a disk header with size and mtime', () => {
  const result = dispatchRunHelpTool(
    deps({ readArtifact: () => diskRead('package main') }),
    'read_artifact',
    '{"path":"main.go"}'
  )
  const [header, ...rest] = result.split('\n')
  assert.equal(
    header,
    `[main.go — on disk, 12 bytes, modified ${new Date(1700000000000).toISOString()}]`
  )
  assert.equal(rest.join('\n'), 'package main')
})

test('read_artifact marks an unsaved editor buffer in the header', () => {
  const result = dispatchRunHelpTool(
    deps({ readArtifact: () => bufferRead('draft bytes') }),
    'read_artifact',
    '{"path":"main.go"}'
  )
  const [header, ...rest] = result.split('\n')
  assert.equal(header, '[main.go — unsaved editor buffer, 11 bytes]')
  assert.equal(rest.join('\n'), 'draft bytes')
})

// --- write_artifact ---

test('write_artifact returns the written byte count', () => {
  const written = []
  const result = JSON.parse(
    dispatchRunHelpTool(
      deps({
        writeArtifact: (relPath, content) => {
          written.push([relPath, content])
          return { bytes: Buffer.byteLength(content, 'utf8') }
        }
      }),
      'write_artifact',
      '{"path":"src/fixed.go","content":"package main"}'
    )
  )
  assert.deepEqual(result, { written: true, path: 'src/fixed.go', bytes: 12 })
  assert.deepEqual(written, [['src/fixed.go', 'package main']])
})

test('write_artifact refuses a missing path or non-string content', () => {
  const noPath = JSON.parse(dispatchRunHelpTool(deps(), 'write_artifact', '{"content":"x"}'))
  assert.match(noPath.error, /path must be a non-empty string/)
  const noContent = JSON.parse(dispatchRunHelpTool(deps(), 'write_artifact', '{"path":"a"}'))
  assert.match(noContent.error, /content must be a string/)
})

test('write_artifact caps oversized content before touching the dep', () => {
  let called = false
  const result = JSON.parse(
    dispatchRunHelpTool(
      deps({
        writeArtifact: () => {
          called = true
          return { bytes: 1 }
        }
      }),
      'write_artifact',
      JSON.stringify({ path: 'a.txt', content: 'x'.repeat(33 * 1024) })
    )
  )
  assert.match(result.error, /content too large/)
  assert.equal(called, false)
})

test('write_artifact returns dep refusals (unsaved buffer, escapes) as JSON content', () => {
  const result = JSON.parse(
    dispatchRunHelpTool(
      deps({
        writeArtifact: () => {
          throw new Error("a.txt has unsaved changes in the user's editor")
        }
      }),
      'write_artifact',
      '{"path":"a.txt","content":"x"}'
    )
  )
  assert.match(result.error, /unsaved changes/)
})

test('get_run_json returns null content when there is no run.json', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'get_run_json', '{}'))
  assert.equal(result.content, null)
})

test('get_run_json caps an oversized run.json', () => {
  const big = 'x'.repeat(40 * 1024)
  const result = dispatchRunHelpTool(deps({ getRunJson: () => big }), 'get_run_json', '{}')
  assert.ok(result.length < 33 * 1024)
  assert.match(result, /truncated/)
})

test('an unknown tool is a JSON error, not a throw', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'delete_everything', '{}'))
  assert.match(result.error, /Unknown tool: delete_everything/)
})

test('malformed argument JSON is a JSON error, not a throw', () => {
  const result = JSON.parse(dispatchRunHelpTool(deps(), 'read_artifact', '{oops'))
  assert.match(result.error, /not valid JSON/)
})

// --- assembleToolCalls ---

test('a single call assembles id+name from the first fragment and arguments from the rest', () => {
  const calls = assembleToolCalls([
    { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
    { index: 0, function: { arguments: '{"city":' } },
    { index: 0, function: { arguments: '"Paris"}' } }
  ])
  assert.deepEqual(calls, [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }])
})

test('parallel calls assemble independently by index, ordered', () => {
  const calls = assembleToolCalls([
    { index: 1, id: 'call_b', function: { name: 'b', arguments: '{}' } },
    { index: 0, id: 'call_a', function: { name: 'a', arguments: '' } },
    { index: 0, function: { arguments: '{"x":1}' } }
  ])
  assert.deepEqual(calls, [
    { id: 'call_a', name: 'a', arguments: '{"x":1}' },
    { id: 'call_b', name: 'b', arguments: '{}' }
  ])
})

test('malformed fragments are skipped; a call without id stays id-less', () => {
  const calls = assembleToolCalls([null, 'junk', { index: 0, function: { name: 'a' } }])
  assert.deepEqual(calls, [{ id: '', name: 'a', arguments: '' }])
})

test('a fragment without an index joins call 0', () => {
  const calls = assembleToolCalls([
    { id: 'call_1', function: { name: 'a', arguments: '' } },
    { function: { arguments: '{"x":1}' } }
  ])
  assert.deepEqual(calls, [{ id: 'call_1', name: 'a', arguments: '{"x":1}' }])
})

// --- runHelpLoop ---

const contentRound = (content) => ({ content, toolCalls: [], finishReason: 'stop' })
const toolRound = (calls) => ({ content: '', toolCalls: calls, finishReason: 'tool_calls' })

test('a content round ends the loop and returns the content', async () => {
  const rounds = []
  const streamRound = async (body) => {
    rounds.push(body)
    return contentRound('the answer')
  }
  const result = await runHelpLoop(streamRound, deps(), 'model-x', [
    { role: 'user', content: 'hi' }
  ])
  assert.equal(result, 'the answer')
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].model, 'model-x')
  assert.equal(rounds[0].tools, RUN_HELP_TOOLS)
})

test('a tool round appends the assistant message and dispatched results, then continues', async () => {
  const seen = []
  const streamRound = async (body) => {
    seen.push(body)
    if (seen.length === 1) {
      return toolRound([{ id: 'call_1', name: 'get_run_output', arguments: '{}' }])
    }
    return contentRound('fixed it')
  }
  const run = {
    command: 'go run x.go',
    exitCode: 1,
    signal: null,
    stdoutTail: '',
    stderrTail: 'boom',
    endedAt: 1
  }
  const result = await runHelpLoop(streamRound, deps({ getLastRun: () => run }), 'm', [
    { role: 'user', content: 'help' }
  ])
  assert.equal(result, 'fixed it')
  // Round 1 sees the user message; round 2 sees it plus the assistant
  // tool_calls message and the dispatched role:tool result — and the
  // tools are offered on every round.
  assert.equal(seen[0].messages.length, 1)
  assert.equal(seen[1].messages.length, 3)
  assert.equal(seen[1].tools, RUN_HELP_TOOLS)
  const [assistantMsg, toolMsg] = seen[1].messages.slice(1)
  assert.equal(assistantMsg.role, 'assistant')
  assert.equal(assistantMsg.content, null)
  assert.deepEqual(assistantMsg.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_run_output', arguments: '{}' } }
  ])
  assert.equal(toolMsg.role, 'tool')
  assert.equal(toolMsg.tool_call_id, 'call_1')
  assert.match(toolMsg.content, /boom/)
})

test('a tool round with content preserves it on the assistant message', async () => {
  const seen = []
  const streamRound = async (body) => {
    seen.push(body)
    if (seen.length === 1) {
      return {
        content: 'Let me check.',
        toolCalls: [{ id: 'c1', name: 'list_artifacts', arguments: '{}' }],
        finishReason: 'tool_calls'
      }
    }
    return contentRound('done')
  }
  await runHelpLoop(streamRound, deps(), 'm', [{ role: 'user', content: 'hi' }])
  const assistantMsg = seen[1].messages[1]
  assert.equal(assistantMsg.content, 'Let me check.')
})

test('a round with parallel tool calls appends one assistant message and ordered results', async () => {
  const seen = []
  const streamRound = async (body) => {
    seen.push(body)
    if (seen.length === 1) {
      return toolRound([
        { id: 'c1', name: 'list_artifacts', arguments: '{}' },
        { id: 'c2', name: 'get_run_json', arguments: '{}' }
      ])
    }
    return contentRound('done')
  }
  await runHelpLoop(streamRound, deps(), 'm', [{ role: 'user', content: 'hi' }])
  const round2 = seen[1].messages
  assert.equal(round2.length, 4) // user + assistant + 2 tool results
  assert.equal(round2[1].tool_calls.length, 2)
  assert.deepEqual(
    round2.slice(2).map((m) => [m.role, m.tool_call_id]),
    [
      ['tool', 'c1'],
      ['tool', 'c2']
    ]
  )
})

test('the loop propagates round errors', async () => {
  const streamRound = async () => {
    throw new Error('HTTP 500')
  }
  await assert.rejects(runHelpLoop(streamRound, deps(), 'm', []), /HTTP 500/)
})

test('the loop throws after 6 consecutive tool rounds', async () => {
  let calls = 0
  const streamRound = async () => {
    calls++
    return toolRound([{ id: `call_${calls}`, name: 'get_run_json', arguments: '{}' }])
  }
  await assert.rejects(runHelpLoop(streamRound, deps(), 'm', []), /did not converge in 6/)
  assert.equal(calls, 6)
})

test('a tool call without an id aborts the loop', async () => {
  const streamRound = async () => toolRound([{ id: '', name: 'get_run_json', arguments: '{}' }])
  await assert.rejects(runHelpLoop(streamRound, deps(), 'm', []), /Malformed tool call/)
})
