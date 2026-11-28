/*
 * Unit tests for the chat-picker merge (conversations + workspace
 * directories). Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeChatPickerEntries } from '../.tmp/unit-build/renderer/src/utils/chatPicker.js'

test('conversations lead in updatedAt desc; dir-less chats are selectable', () => {
  const entries = mergeChatPickerEntries(
    [
      { id: 'c1', title: 'Older', updatedAt: 100 },
      { id: 'c2', title: 'Rust course', updatedAt: 200 },
      { id: 'c3', title: 'Oldest', updatedAt: 50 }
    ],
    ['c1']
  )
  assert.deepEqual(
    entries.map((e) => [e.id, e.hasDir]),
    [
      ['c2', false],
      ['c1', true],
      ['c3', false]
    ],
    'recency order, hasDir reflects the disk'
  )
  assert.equal(entries[0].title, 'Rust course')
})

test('orphan directories (deleted conversations) follow, sorted by name', () => {
  const entries = mergeChatPickerEntries(
    [{ id: 'kept', title: 'Kept', updatedAt: 10 }],
    ['kept', 'zzz-orphan', 'aaa-orphan']
  )
  assert.deepEqual(
    entries.map((e) => e.id),
    ['kept', 'aaa-orphan', 'zzz-orphan']
  )
  assert.ok(entries.slice(1).every((e) => e.hasDir))
  assert.equal(entries[1].title, 'aaa-orphan', 'orphan label is its directory name')
})

test("the 'new' sentinel never appears; empty inputs give an empty list", () => {
  const entries = mergeChatPickerEntries(
    [
      { id: 'new', title: 'New Conversation', updatedAt: 999 },
      { id: 'real', title: 'Real', updatedAt: 1 }
    ],
    ['new']
  )
  assert.deepEqual(
    entries.map((e) => e.id),
    ['real']
  )
  assert.deepEqual(mergeChatPickerEntries([], []), [])
})
