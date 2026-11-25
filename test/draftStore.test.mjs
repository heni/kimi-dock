/*
 * Unit tests for the in-memory draft store (pure part; saveAllDrafts needs
 * window.api and is exercised manually). Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setDraft,
  getDraft,
  clearDraft,
  hasDraft,
  dirtyPaths,
  dirtyCount,
  subscribeDrafts
} from '../.tmp/unit-build/renderer/src/utils/draftStore.js'

// Each test uses its own chat id — the store is a module singleton.
test('set/get/clear round-trip; clean content self-deletes', () => {
  setDraft('t1', 'a.md', 'draft', 'disk')
  assert.deepEqual(getDraft('t1', 'a.md'), { content: 'draft', base: 'disk' })
  assert.equal(hasDraft('t1', 'a.md'), true)
  // Typing back to the disk content clears the entry.
  setDraft('t1', 'a.md', 'disk', 'disk')
  assert.equal(hasDraft('t1', 'a.md'), false)
  setDraft('t1', 'b.md', 'x', 'y')
  clearDraft('t1', 'b.md')
  assert.equal(dirtyCount('t1'), 0)
})

test('dirtyPaths and dirtyCount are scoped per chat', () => {
  setDraft('t2', 'a.md', '1', '0')
  setDraft('t2', 'src/b.py', '2', '0')
  setDraft('t3', 'c.md', '3', '0')
  assert.deepEqual(dirtyPaths('t2'), ['a.md', 'src/b.py'])
  assert.equal(dirtyCount('t2'), 2)
  assert.equal(dirtyCount('t3'), 1)
  assert.ok(dirtyCount() >= 3)
  clearDraft('t2', 'a.md')
  clearDraft('t2', 'src/b.py')
  clearDraft('t3', 'c.md')
})

test('subscribers fire on mutations, not on no-ops', () => {
  let calls = 0
  const off = subscribeDrafts(() => {
    calls += 1
  })
  setDraft('t4', 'a.md', 'x', 'y')
  const after = calls
  assert.ok(after > 0)
  setDraft('t4', 'a.md', 'x', 'y') // identical — no notify
  assert.equal(calls, after)
  clearDraft('t4', 'a.md')
  assert.ok(calls > after)
  off()
  setDraft('t4', 'b.md', 'x', 'y')
  const total = calls
  clearDraft('t4', 'b.md')
  assert.equal(calls, total) // unsubscribed
})
