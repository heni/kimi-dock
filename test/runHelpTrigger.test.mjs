/*
 * Unit tests for the AI run-help trigger builder (src/renderer/src/utils/runHelp.ts).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRunHelpTrigger,
  selectRunHelpContext
} from '../.tmp/unit-build/renderer/src/utils/runHelp.js'

test('a failed run asks to diagnose it, with the command and its source', () => {
  const text = buildRunHelpTrigger({
    file: 'src/test.go',
    command: 'go run src/test.go',
    source: 'builtin',
    exitCode: 1,
    signal: null
  })
  assert.equal(
    text,
    'Разберись с последним запуском `src/test.go`: exit 1, команда (built-in): `go run src/test.go`'
  )
})

test('a killed run names the signal instead of an exit code', () => {
  const text = buildRunHelpTrigger({
    file: 'a.py',
    command: 'python a.py',
    source: 'free-form',
    exitCode: null,
    signal: 'SIGTERM'
  })
  assert.match(text, /killed \(SIGTERM\)/)
  assert.match(text, /команда \(free-form\)/)
})

test('no run yet says so', () => {
  const text = buildRunHelpTrigger({
    file: 'main.go',
    command: 'go run main.go',
    source: 'run-json',
    exitCode: null,
    signal: null
  })
  assert.match(text, /запуск ещё не выполнялся/)
  assert.match(text, /команда \(run\.json\)/)
})

test('a successful run asks to explain the program', () => {
  const text = buildRunHelpTrigger({
    file: 'src/test.go',
    command: 'go run src/test.go',
    source: 'builtin',
    exitCode: 0,
    signal: null
  })
  assert.match(text, /^Объясни, что делает программа в `src\/test\.go`/)
  assert.match(text, /exit 0/)
})

test('a long command is capped in the trigger', () => {
  const text = buildRunHelpTrigger({
    file: 'a.sh',
    command: `echo ${'x'.repeat(500)}`,
    source: 'free-form',
    exitCode: 1,
    signal: null
  })
  assert.ok(text.length < 400)
  assert.match(text, /…`$/)
})

test('a run in flight says so instead of claiming no runs', () => {
  const text = buildRunHelpTrigger({
    file: 'a.py',
    command: 'python a.py',
    source: 'builtin',
    exitCode: null,
    signal: null,
    running: true
  })
  assert.match(text, /запущен и ещё выполняется/)
  assert.doesNotMatch(text, /ещё не выполнялся/)
})

test('an exit code wins over the running flag (branch precedence)', () => {
  const text = buildRunHelpTrigger({
    file: 'a.py',
    command: 'python a.py',
    source: 'builtin',
    exitCode: 0,
    signal: null,
    running: true
  })
  assert.match(text, /^Объясни, что делает программа/)
})

// --- selectRunHelpContext ---

const exit = (over = {}) => ({
  code: 1,
  signal: null,
  file: 'a.py',
  command: 'python a.py',
  source: 'builtin',
  ...over
})

test('mid-run: the running command/source, no exit — whatever the previous run was', () => {
  const ctx = selectRunHelpContext({
    running: true,
    runningCtx: { command: 'python edited.py', source: 'free-form' },
    lastExit: exit({ code: 0 }),
    currentFile: 'a.py',
    currentCommand: 'python edited.py',
    currentSource: 'free-form'
  })
  assert.deepEqual(ctx, {
    command: 'python edited.py',
    source: 'free-form',
    exitCode: null,
    signal: null,
    running: true
  })
})

test('exited: the run’s own command and source, not the current line', () => {
  const ctx = selectRunHelpContext({
    running: false,
    runningCtx: { command: '', source: 'free-form' },
    lastExit: exit({ code: 2, command: 'python a.py', source: 'run-json' }),
    currentFile: 'a.py',
    currentCommand: 'python edited.py',
    currentSource: 'free-form'
  })
  assert.deepEqual(ctx, {
    command: 'python a.py',
    source: 'run-json',
    exitCode: 2,
    signal: null,
    running: false
  })
})

test('no run for this file: the current line, no exit', () => {
  const ctx = selectRunHelpContext({
    running: false,
    runningCtx: { command: '', source: 'free-form' },
    lastExit: exit({ file: 'other.py' }),
    currentFile: 'a.py',
    currentCommand: 'python a.py',
    currentSource: 'builtin'
  })
  assert.deepEqual(ctx, {
    command: 'python a.py',
    source: 'builtin',
    exitCode: null,
    signal: null,
    running: false
  })
})
