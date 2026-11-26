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
import { resolveInWorkspaceReal } from '../.tmp/unit-build/main/workspace.js'

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
