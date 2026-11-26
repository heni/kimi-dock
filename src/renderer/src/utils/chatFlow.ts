// Send-flow transformations for the offline chat: the pure logic behind the
// serial send queue. No React, no IndexedDB — unit tests compile this module
// with the project's tsc and run it under node:test (see npm run test:unit).

import type { Conversation, Message } from './offlineManagerSchema'

// A user message enters the conversation as 'pending': queued for delivery,
// it stays so until a request that included it succeeds. updatedAt bumps —
// a new message is user-visible activity.
export function appendUserMessage(
  conversation: Conversation,
  input: { id: string; content: string; now: number; runHelp?: { chatId: string } }
): Conversation {
  const message: Message = {
    id: input.id,
    role: 'user',
    content: input.content,
    timestamp: input.now,
    syncStatus: 'pending',
    queuedAt: input.now,
    ...(input.runHelp !== undefined ? { runHelp: input.runHelp } : {})
  }
  return {
    ...conversation,
    title: conversation.title || input.content.substring(0, 50),
    messages: [...conversation.messages, message],
    updatedAt: input.now
  }
}

// The request body for the coding API: the full history, each message
// exactly once. Roles/content only — the API needs no local fields.
export function toApiMessages(messages: Message[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

// User messages still waiting for delivery, in conversation order.
export function pendingUserMessages(conversation: Conversation): Message[] {
  return conversation.messages.filter((m) => m.role === 'user' && m.syncStatus === 'pending')
}

// Apply the reply to the messages that were actually sent: exactly those are
// marked 'synced'; messages queued while the request was in flight stay
// 'pending' for the next pass. The caller applies this to a fresh read of
// the stored record, so nothing queued mid-flight is overwritten. The reply
// itself carries no syncStatus — it is the delivery, not a queued item.
export function applyAssistantReply(
  conversation: Conversation,
  sentIds: readonly string[],
  input: { id: string; content: string; now: number }
): Conversation {
  const sent = new Set(sentIds)
  const messages = conversation.messages.map((message) =>
    sent.has(message.id) && message.role === 'user'
      ? { ...message, syncStatus: 'synced' as const, syncedAt: input.now }
      : message
  )
  messages.push({
    id: input.id,
    role: 'assistant',
    content: input.content,
    timestamp: input.now
  })
  return { ...conversation, messages, isOffline: false, updatedAt: input.now }
}

// User-stopped stream with no content yet: the sent messages were delivered
// (the request went out and consumed quota), so exactly those are marked
// 'synced' — but there is no reply to append. Same fresh-read discipline as
// applyAssistantReply: the caller applies this to a fresh read of the record.
export function markSentSynced(
  conversation: Conversation,
  sentIds: readonly string[],
  now: number
): Conversation {
  const sent = new Set(sentIds)
  const messages = conversation.messages.map((message) =>
    sent.has(message.id) && message.role === 'user'
      ? { ...message, syncStatus: 'synced' as const, syncedAt: now }
      : message
  )
  return { ...conversation, messages, isOffline: false, updatedAt: now }
}

// AI run-help pass info: a conversation holding a run-help trigger gets the
// tool loop on every request (the marker carries the tools' chat directory,
// which for a trigger sent to a fresh chat differs from the conversation's
// own id); the one-shot skill rides only a pass whose pending set contains
// a trigger. When several triggers accumulated, the LAST marker wins — the
// latest ✨ expresses the current intent (an Alt+click-minted chat may grow
// its own artifacts and get its own trigger later).
export function runHelpPassInfo(
  messages: Message[],
  pending: Message[]
): { toolsChatId: string | undefined; skillThisPass: boolean } {
  let toolsChatId: string | undefined
  for (const message of messages) {
    if (message.runHelp) toolsChatId = message.runHelp.chatId
  }
  return {
    toolsChatId,
    skillThisPass: pending.some((m) => m.runHelp !== undefined)
  }
}
