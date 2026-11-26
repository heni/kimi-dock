/*
 * Unit tests for the symlink-aware workspace confinement used by the
 * run-help tools (src/main/workspace.ts resolveInWorkspaceReal).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveInWorkspaceReal, canonicalWorkspaceRel } from '../.tmp/unit-build/main/workspace.js'

// A scratch workspace: root/chat with a real file, plus an "outside"
// directory that symlinks may point at.
const setup = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-ws-'))
  const root = path.join(base, 'root')
  const chat = path.join(root, 'chat')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(chat, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(chat, 'real.txt'), 'inside')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')
  return { base, root, chat, outside }
}

const cleanup = (base) => fs.rmSync(base, { recursive: true, force: true })

test('read: a plain file inside resolves', () => {
  const { base, chat } = setup()
  try {
    assert.equal(resolveInWorkspaceReal(chat, 'real.txt', false), path.join(chat, 'real.txt'))
  } finally {
    cleanup(base)
  }
})

test('read: a symlink escaping the chat directory is refused', () => {
  const { base, chat, outside } = setup()
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(chat, 'link.txt'))
    assert.throws(() => resolveInWorkspaceReal(chat, 'link.txt', false), /symlink escape/)
  } finally {
    cleanup(base)
  }
})

test('read: a symlink staying inside resolves', () => {
  const { base, chat } = setup()
  try {
    fs.symlinkSync(path.join(chat, 'real.txt'), path.join(chat, 'alias.txt'))
    assert.equal(resolveInWorkspaceReal(chat, 'alias.txt', false), path.join(chat, 'alias.txt'))
  } finally {
    cleanup(base)
  }
})

test('write: a new file in an existing directory resolves', () => {
  const { base, chat } = setup()
  try {
    assert.equal(
      resolveInWorkspaceReal(chat, 'sub/new.txt', true),
      path.join(chat, 'sub', 'new.txt')
    )
  } finally {
    cleanup(base)
  }
})

test('write: a symlinked directory escaping the chat is refused for a not-yet-existing file', () => {
  const { base, chat, outside } = setup()
  try {
    fs.symlinkSync(outside, path.join(chat, 'dirlink'), 'dir')
    assert.throws(() => resolveInWorkspaceReal(chat, 'dirlink/new.txt', true), /symlink escape/)
  } finally {
    cleanup(base)
  }
})

test('write: an existing symlink target escaping the chat is refused', () => {
  const { base, chat, outside } = setup()
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(chat, 'link.txt'))
    assert.throws(() => resolveInWorkspaceReal(chat, 'link.txt', true), /symlink escape/)
  } finally {
    cleanup(base)
  }
})

test('write: overwriting a plain file inside resolves', () => {
  const { base, chat } = setup()
  try {
    assert.equal(resolveInWorkspaceReal(chat, 'real.txt', true), path.join(chat, 'real.txt'))
  } finally {
    cleanup(base)
  }
})

test('lexical escapes are still refused before any symlink check', () => {
  const { base, chat } = setup()
  try {
    assert.throws(() => resolveInWorkspaceReal(chat, '../x.txt', true), /outside the workspace/)
    assert.throws(() => resolveInWorkspaceReal(chat, '/etc/passwd', false), /absolute path/)
  } finally {
    cleanup(base)
  }
})

// Regression: existsSync follows links, so a dangling final-component
// symlink used to skip every check while writeFileSync followed it outside.
test('write: a dangling symlink to an OUTSIDE missing file is refused', () => {
  const { base, chat, outside } = setup()
  try {
    fs.symlinkSync(path.join(outside, 'missing.txt'), path.join(chat, 'link.txt'))
    assert.throws(() => resolveInWorkspaceReal(chat, 'link.txt', true), /symlink escape/)
  } finally {
    cleanup(base)
  }
})

test('write: a dangling symlink to an INSIDE missing file is allowed', () => {
  const { base, chat } = setup()
  try {
    fs.symlinkSync(path.join(chat, 'sub', 'missing.txt'), path.join(chat, 'link.txt'))
    assert.equal(resolveInWorkspaceReal(chat, 'link.txt', true), path.join(chat, 'link.txt'))
  } finally {
    cleanup(base)
  }
})

test('write: a two-level chain link -> link2 -> outside-missing is refused', () => {
  const { base, chat, outside } = setup()
  try {
    fs.symlinkSync(path.join(outside, 'missing.txt'), path.join(chat, 'link2.txt'))
    fs.symlinkSync(path.join(chat, 'link2.txt'), path.join(chat, 'link.txt'))
    assert.throws(() => resolveInWorkspaceReal(chat, 'link.txt', true), /symlink escape/)
  } finally {
    cleanup(base)
  }
})

// One canonicalization for buffer keys and tool paths: './x' and 'x' must
// hit the same entry, or the write-refusal guard silently misses.
test('canonicalWorkspaceRel: ./x and x canonicalize to the same key', () => {
  const { base, chat } = setup()
  try {
    assert.equal(canonicalWorkspaceRel(chat, './x'), 'x')
    assert.equal(canonicalWorkspaceRel(chat, 'x'), 'x')
    assert.equal(canonicalWorkspaceRel(chat, './x'), canonicalWorkspaceRel(chat, 'x'))
  } finally {
    cleanup(base)
  }
})

test('canonicalWorkspaceRel: a/../x canonicalizes to x', () => {
  const { base, chat } = setup()
  try {
    assert.equal(canonicalWorkspaceRel(chat, 'a/../x'), 'x')
  } finally {
    cleanup(base)
  }
})

test('canonicalWorkspaceRel: an escape key throws', () => {
  const { base, chat } = setup()
  try {
    assert.throws(() => canonicalWorkspaceRel(chat, '../x'), /outside the workspace/)
  } finally {
    cleanup(base)
  }
})
