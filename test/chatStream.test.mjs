/*
 * Unit tests for the SSE parser and stream-event classification behind the
 * offline chat's streaming replies (src/main/chatStream.ts).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser, classifyStreamEvent } from '../.tmp/unit-build/main/chatStream.js'

// --- createSseParser ---

test('a single complete event is dispatched on the blank line', () => {
  const parser = createSseParser()
  const events = parser.feed('data: {"a":1}\n\n')
  assert.deepEqual(events, [{ data: '{"a":1}' }])
})

test('multi-line data joins with newlines', () => {
  const parser = createSseParser()
  const events = parser.feed('data: line1\ndata: line2\n\n')
  assert.deepEqual(events, [{ data: 'line1\nline2' }])
})

test('an event split across chunks waits for the rest', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: {"a"'), [])
  assert.deepEqual(parser.feed(':1}\n'), [])
  assert.deepEqual(parser.feed('\n'), [{ data: '{"a":1}' }])
})

test('keep-alive comment lines produce no events', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed(': ping\n\n'), [])
  assert.deepEqual(parser.feed(':ping\ndata: x\n\n'), [{ data: 'x' }])
})

test('multiple events in one chunk all dispatch', () => {
  const parser = createSseParser()
  const events = parser.feed('data: 1\n\ndata: 2\n\n')
  assert.deepEqual(events, [{ data: '1' }, { data: '2' }])
})

test('[DONE] arrives as an ordinary data payload', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: [DONE]\n\n'), [{ data: '[DONE]' }])
})

test('crlf line endings are stripped', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: x\r\n\r\n'), [{ data: 'x' }])
})

test('a trailing event without the final blank line flushes on end()', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: x\n'), [])
  assert.deepEqual(parser.end(), [{ data: 'x' }])
})

test('one leading space after data: is stripped, more are kept', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data:  x\n\n'), [{ data: ' x' }])
  assert.deepEqual(parser.feed('data:x\n\n'), [{ data: 'x' }])
})

// --- classifyStreamEvent ---

test('[DONE] classifies as done', () => {
  assert.deepEqual(classifyStreamEvent('[DONE]'), { kind: 'done' })
})

test('a content delta classifies as content', () => {
  const data = JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'content', text: 'Hello' })
})

test('the role-only first delta (empty content) is ignored', () => {
  const data = JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'ignore' })
})

test('a reasoning delta classifies as reasoning (dropped, not forwarded)', () => {
  const data = JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'reasoning' })
})

test('a finish delta carries the reason', () => {
  const data = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'finish', reason: 'stop' })
})

test('content in a finish delta is not lost (content wins)', () => {
  const data = JSON.stringify({
    choices: [{ delta: { content: 'end' }, finish_reason: 'stop' }]
  })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'content', text: 'end' })
})

test('a tool_calls delta classifies as toolCalls', () => {
  const data = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1' }] } }]
  })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'toolCalls' })
})

test('a mid-stream error payload classifies as error', () => {
  const data = JSON.stringify({ error: { message: 'boom' } })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'error', message: 'boom' })
})

test('unparseable data is ignored', () => {
  assert.deepEqual(classifyStreamEvent('not json'), { kind: 'ignore' })
})

test('an empty choices array is ignored', () => {
  assert.deepEqual(classifyStreamEvent(JSON.stringify({ choices: [] })), { kind: 'ignore' })
})

test('a null choice entry is ignored, not thrown on', () => {
  assert.deepEqual(classifyStreamEvent(JSON.stringify({ choices: [null] })), { kind: 'ignore' })
})

test('an error payload without a message falls back to a generic one', () => {
  const data = JSON.stringify({ error: { code: 'rate_limited' } })
  assert.deepEqual(classifyStreamEvent(data), { kind: 'error', message: 'Stream error' })
})

test('a non-object JSON payload is ignored', () => {
  assert.deepEqual(classifyStreamEvent('42'), { kind: 'ignore' })
  assert.deepEqual(classifyStreamEvent('"x"'), { kind: 'ignore' })
})
