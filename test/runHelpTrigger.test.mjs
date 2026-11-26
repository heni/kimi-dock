/*
 * Unit tests for the AI run-help renderer helpers
 * (src/renderer/src/utils/runHelp.ts): the trigger builder, the run-context
 * selector and the unsaved-buffers push.
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRunHelpTrigger,
  selectRunHelpContext,
  collectRunHelpBuffers,
  RUN_HELP_BUFFER_MAX_ENTRIES,
  RUN_HELP_BUFFER_MAX_CHARS
} from '../.tmp/unit-build/renderer/src/utils/runHelp.js'
import { setDraft, clearAllDrafts } from '../.tmp/unit-build/renderer/src/utils/draftStore.js'

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

test('a dirty file adds the buffer notice to the trigger', () => {
  const text = buildRunHelpTrigger({
    file: 'src/test.go',
    command: 'go run src/test.go',
    source: 'builtin',
    exitCode: 1,
    signal: null,
    fileDirty: true
  })
  assert.match(text, /несохранённые изменения в редакторе/)
  assert.match(text, /read_artifact вернёт актуальный буфер/)
})

test('a clean file adds no buffer notice (both branches)', () => {
  const failed = buildRunHelpTrigger({
    file: 'a.py',
    command: 'python a.py',
    source: 'builtin',
    exitCode: 1,
    signal: null
  })
  const ok = buildRunHelpTrigger({
    file: 'a.py',
    command: 'python a.py',
    source: 'builtin',
    exitCode: 0,
    signal: null,
    fileDirty: false
  })
  assert.doesNotMatch(failed, /несохранённые изменения/)
  assert.doesNotMatch(ok, /несохранённые изменения/)
})

// --- collectRunHelpBuffers ---

test('collectRunHelpBuffers returns only the chat’s own drafts', () => {
  clearAllDrafts()
  setDraft('c1', 'src/a.go', 'package main // edited', 'package main')
  setDraft('c1', 'b.txt', 'draft b', 'disk b')
  setDraft('c2', 'other.txt', 'other chat', 'x')
  assert.deepEqual(collectRunHelpBuffers('c1'), {
    'src/a.go': 'package main // edited',
    'b.txt': 'draft b'
  })
  clearAllDrafts()
})

test('collectRunHelpBuffers skips drafts over the size cap', () => {
  clearAllDrafts()
  setDraft('c1', 'big.txt', 'x'.repeat(RUN_HELP_BUFFER_MAX_CHARS + 1), 'small')
  setDraft('c1', 'ok.txt', 'fits', 'x')
  assert.deepEqual(collectRunHelpBuffers('c1'), { 'ok.txt': 'fits' })
  clearAllDrafts()
})

test('collectRunHelpBuffers caps the entry count', () => {
  clearAllDrafts()
  for (let i = 0; i < RUN_HELP_BUFFER_MAX_ENTRIES + 5; i++) {
    setDraft('c1', `f${String(i).padStart(3, '0')}.txt`, `content ${i}`, '')
  }
  assert.equal(Object.keys(collectRunHelpBuffers('c1')).length, RUN_HELP_BUFFER_MAX_ENTRIES)
  clearAllDrafts()
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
    runningFile: 'a.py',
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
    runningFile: null,
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
    runningFile: null,
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

test('a run in flight for ANOTHER file does not leak: this file’s exit is used', () => {
  const ctx = selectRunHelpContext({
    running: true,
    runningFile: 'other.py',
    runningCtx: { command: 'python other.py', source: 'builtin' },
    lastExit: exit({ code: 1 }),
    currentFile: 'a.py',
    currentCommand: 'python a.py',
    currentSource: 'builtin'
  })
  assert.deepEqual(ctx, {
    command: 'python a.py',
    source: 'builtin',
    exitCode: 1,
    signal: null,
    running: false
  })
})
