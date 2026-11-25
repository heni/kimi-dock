/*
 * Unit tests for the artifact-cycling arithmetic (extracted in 3.5.11 —
 * the cases the 3.5.8 review loop walked by hand, incl. its F01 off-by-one).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextArtifactPath } from '../.tmp/unit-build/renderer/src/utils/artifactNav.js'

const PATHS = ['a.md', 'b.py', 'c.txt']

test('empty list is a no-op in both directions', () => {
  assert.equal(nextArtifactPath([], null, false), null)
  assert.equal(nextArtifactPath([], 'a.md', true), null)
})

test('forward: steps, wraps from the last to the first', () => {
  assert.equal(nextArtifactPath(PATHS, 'a.md', false), 'b.py')
  assert.equal(nextArtifactPath(PATHS, 'c.txt', false), 'a.md')
})

test('backward: steps, wraps from the first to the last', () => {
  assert.equal(nextArtifactPath(PATHS, 'b.py', true), 'a.md')
  assert.equal(nextArtifactPath(PATHS, 'a.md', true), 'c.txt')
})

test('nothing open: forward opens the first, backward the last', () => {
  assert.equal(nextArtifactPath(PATHS, null, false), 'a.md')
  assert.equal(nextArtifactPath(PATHS, null, true), 'c.txt')
})

test('current missing from the list (deleted/renamed): same as nothing open', () => {
  assert.equal(nextArtifactPath(PATHS, 'gone.md', false), 'a.md')
  assert.equal(nextArtifactPath(PATHS, 'gone.md', true), 'c.txt')
})

test('single file: no-op when it is open, opens when nothing is', () => {
  assert.equal(nextArtifactPath(['only.md'], 'only.md', false), null)
  assert.equal(nextArtifactPath(['only.md'], 'only.md', true), null)
  assert.equal(nextArtifactPath(['only.md'], null, false), 'only.md')
})
