/*
 * Unit tests for the external-change reconciliation decision
 * (src/renderer/src/utils/editorSync.ts).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideExternalChange } from '../.tmp/unit-build/renderer/src/utils/editorSync.js'

test('no draft, disk matches the shown content → none', () => {
  assert.deepEqual(
    decideExternalChange({
      diskContent: 'same',
      currentContent: 'same',
      draftBase: null,
      suppressedDisk: null
    }),
    { kind: 'none' }
  )
})

test('no draft, disk moved → reload', () => {
  assert.deepEqual(
    decideExternalChange({
      diskContent: 'AI fixed version',
      currentContent: 'stale buffer',
      draftBase: null,
      suppressedDisk: null
    }),
    { kind: 'reload' }
  )
})

test('draft present, disk still at the draft baseline → none (own unsaved work, not a conflict)', () => {
  assert.deepEqual(
    decideExternalChange({
      diskContent: 'base',
      currentContent: 'base + my edits',
      draftBase: 'base',
      suppressedDisk: null
    }),
    { kind: 'none' }
  )
})

test('draft present, disk moved from the baseline → conflict', () => {
  assert.deepEqual(
    decideExternalChange({
      diskContent: 'AI wrote this',
      currentContent: 'base + my edits',
      draftBase: 'base',
      suppressedDisk: null
    }),
    { kind: 'conflict' }
  )
})

test('conflict suppressed for THIS disk version → none; a newer disk change re-arms', () => {
  const suppressed = {
    diskContent: 'AI wrote this',
    currentContent: 'base + my edits',
    draftBase: 'base',
    suppressedDisk: 'AI wrote this'
  }
  assert.deepEqual(decideExternalChange(suppressed), { kind: 'none' })
  assert.deepEqual(decideExternalChange({ ...suppressed, diskContent: 'AI wrote MORE' }), {
    kind: 'conflict'
  })
})

test('suppression is ignored once there is no draft (the save path clears state first)', () => {
  assert.deepEqual(
    decideExternalChange({
      diskContent: 'anything',
      currentContent: 'different',
      draftBase: null,
      suppressedDisk: 'anything'
    }),
    { kind: 'reload' }
  )
})
