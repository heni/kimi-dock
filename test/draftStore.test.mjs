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

test('saveAllDrafts: saves only the given chat, clears saved, keeps failed', async () => {
  const writes = []
  globalThis.window = {
    api: {
      fsWrite: async (path, content) => {
        writes.push([path, content])
        return path.includes('bad') ? { success: false, error: 'nope' } : { success: true }
      }
    }
  }
  const { saveAllDrafts } = await import('../.tmp/unit-build/renderer/src/utils/draftStore.js')
  setDraft('t5', 'ok.md', 'v1', 'd')
  setDraft('t5', 'bad.md', 'v2', 'd')
  setDraft('t6', 'other.md', 'v3', 'd')
  const { saved, failed } = await saveAllDrafts('t5')
  assert.equal(saved, 1)
  assert.equal(failed, 1)
  assert.equal(hasDraft('t5', 'ok.md'), false, 'saved draft clears')
  assert.equal(hasDraft('t5', 'bad.md'), true, 'failed draft kept')
  assert.equal(hasDraft('t6', 'other.md'), true, 'other chat untouched')
  assert.ok(
    writes.every(([p]) => p.startsWith('t5/')),
    'writes scoped to the chat'
  )
  clearDraft('t5', 'bad.md')
  clearDraft('t6', 'other.md')
  delete globalThis.window
})

test('resolveSave: raced keystroke survives, re-based onto disk', async () => {
  const { resolveSave } = await import('../.tmp/unit-build/renderer/src/utils/draftStore.js')
  setDraft('t7', 'a.md', 'written', 'disk0')
  // A keystroke lands while the write is in flight.
  setDraft('t7', 'a.md', 'written+more', 'disk0')
  resolveSave('t7', 'a.md', 'written')
  assert.deepEqual(getDraft('t7', 'a.md'), { content: 'written+more', base: 'written' })
  // No race: the entry clears.
  setDraft('t7', 'b.md', 'x', 'y')
  resolveSave('t7', 'b.md', 'x')
  assert.equal(hasDraft('t7', 'b.md'), false)
  clearDraft('t7', 'a.md')
})
