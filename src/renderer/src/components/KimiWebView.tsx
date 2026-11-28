import { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react'
import { Conversation, offlineManager } from '../utils/offlineManager'
import ChatMarkdown from './ChatMarkdown'
import {
  appendUserMessage,
  applyAssistantReply,
  markSentSynced,
  pendingUserMessages,
  runHelpPassInfo,
  toApiMessages
} from '../utils/chatFlow'
import RUN_JSON_SKILL from '../../../../resources/skills/run-json/SKILL.md?raw'
import RUN_HELP_SKILL from '../../../../resources/skills/run-help/SKILL.md?raw'
import { collectRunHelpBuffers } from '../utils/runHelp'
import LoadingSkeleton from './LoadingSkeleton'
import { decideOnlineTransition } from '../utils/transition'
import '../assets/KimiWebView.css'

type ConnectionStatus = 'online' | 'offline' | 'checking' | 'error'

type WebviewTag = HTMLElement & {
  src: string
  reload: () => void
  executeJavaScript: (code: string) => Promise<unknown>
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
}

type WebviewDidFailLoadEvent = Event & {
  errorCode: number
  errorDescription: string
}

type WebviewConsoleMessageEvent = Event & {
  level: number
  message: string
}

interface KimiWebViewProps {
  currentConversation: Conversation | null
  isOffline: boolean
  forceOffline: boolean
  hasSession: boolean
  settingsReady: boolean
  onAuthRequired: () => void
  onOpenArtifacts: (conversation: Conversation) => void
  runSkillArmed: boolean
  onDisarmRunSkill: () => void
  // ✨ Ask AI: a trigger to append and send. targetChatId null mints a
  // fresh conversation; toolsChatId is the artifact's chat the run-help
  // tools are confined to. Consumed exactly once (the callback clears it).
  runHelpTrigger: { targetChatId: string | null; toolsChatId: string; text: string } | null
  onRunHelpTriggerConsumed: () => void
}

export default function KimiWebView({
  currentConversation,
  isOffline,
  forceOffline,
  hasSession,
  settingsReady,
  onAuthRequired,
  onOpenArtifacts,
  runSkillArmed,
  onDisarmRunSkill,
  runHelpTrigger,
  onRunHelpTriggerConsumed
}: KimiWebViewProps): React.JSX.Element {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    navigator.onLine ? 'online' : 'offline'
  )
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  // The conversation the serial queue is currently working on — the typing
  // indicator and send errors render only when it matches the viewed chat.
  const [queueConvId, setQueueConvId] = useState<string | null>(null)
  const [sendError, setSendError] = useState<{ convId: string | null; message: string } | null>(
    null
  )
  // Streaming reply: the provisional bubble's text mirrors the active
  // stream's accumulation. streamRef carries the request identity and the
  // accumulated text (events arrive outside React's render cycle);
  // streamingText is its render mirror, cleared when the reply persists.
  const [streamingText, setStreamingText] = useState('')
  const streamRef = useRef<{ requestId: string; text: string } | null>(null)
  // True from a stream's successful start until its outcome settles: the
  // send button shows ■ stop only while there is a live stream to abort —
  // the pass's prepare phase (queued, nothing to abort yet) shows ⏳ instead.
  const [streamActive, setStreamActive] = useState(false)
  // One waiter per in-flight stream: the queue parks on the promise until
  // the done/error event for its requestId arrives.
  const streamWaitersRef = useRef<
    Map<
      string,
      {
        resolve: (outcome: { aborted: boolean; dispatched: boolean; text: string }) => void
        reject: (error: Error) => void
      }
    >
  >(new Map())
  const streamCounterRef = useRef(0)
  // Copy-answer feedback: which message was just copied (or failed to copy).
  const [copyState, setCopyState] = useState<{ id: string; ok: boolean } | null>(null)
  const copyResetRef = useRef<NodeJS.Timeout | null>(null)
  const webviewRef = useRef<WebviewTag | null>(null)
  // The live webview element as state: load listeners attach off this, so
  // every (re)mount — offline boot, error-UI reload, surface switch —
  // re-arms them. Flag-based effect deps missed remounts where the flags
  // happened not to change.
  const [webviewEl, setWebviewEl] = useState<WebviewTag | null>(null)
  const attachWebview = useCallback((el: WebviewTag | null): void => {
    webviewRef.current = el
    setWebviewEl(el)
  }, [])
  // Keep-mounted (docs/ui-design.md §6): once the webview first mounts, the
  // offline view only CSS-hides it — repeat offline↔online transitions
  // return to the live SPA instantly, without a reload. It mounts lazily
  // and only after the settings are known (the effect below): a boot into
  // offline mode — network or forced — renders no webview until the first
  // transition. isOffline alone cannot gate the first paint: the forced
  // flag arrives asynchronously from settings.
  const [webviewMounted, setWebviewMounted] = useState(false)
  // Set on the first did-finish-load: a loaded SPA self-heals reconnects,
  // so passive transitions stop showing loading states and reloading.
  const loadedOnceRef = useRef(false)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  // Stick-to-bottom: new content auto-scrolls only while the user is at the
  // bottom; someone scrolled up into history is never yanked down.
  const stickToBottomRef = useRef(true)
  // Last message id seen by the auto-scroll effect: the user-role override
  // applies only to a genuine append, not to a queue transition re-firing
  // the effect over a pre-existing pending last message.
  const prevLastMessageIdRef = useRef<string | null>(null)
  // The queue reads the stored record on every pass; this mirror only answers
  // "is the queue's conversation still the one on screen".
  const conversationRef = useRef<Conversation | null>(null)
  const processingRef = useRef(false)
  // Flush calls dropped by the processingRef guard, by conversation id: the
  // draining pass hands the queue to the next one recorded here.
  const pendingConvIdsRef = useRef<Set<string>>(new Set())
  // A repeated submit during the append window would queue the same text
  // twice: the input is cleared only after the record write lands.
  const sendingRef = useRef(false)
  // Serializes read-modify-write cycles on the stored record: the send path
  // (append) and the queue (apply reply) both merge onto a fresh read, and
  // this chain keeps the two merges from overwriting each other.
  const recordChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const withRecordLock = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = recordChainRef.current.then(fn)
    recordChainRef.current = run.catch(() => {})
    return run
  }, [])

  // Initialize active conversation from props. The sidebar's "New Chat"
  // sentinel ('new') means "no conversation yet": the first send mints a
  // real id, so fresh chats never share one record.
  useEffect(() => {
    if (currentConversation) {
      setActiveConversation(currentConversation.id === 'new' ? null : currentConversation)
      setSendError(null)
    }
  }, [currentConversation])

  useEffect(() => {
    conversationRef.current = activeConversation
  }, [activeConversation])

  // ✨ Ask AI: append the trigger and send it through the ordinary queue.
  // The trigger carries the runHelp marker, which enables the tool loop
  // for this conversation and names the tools' chat directory. Consumed
  // exactly once — the callback clears the App-level state up front, so a
  // re-render cannot append the same trigger twice.
  useEffect(() => {
    if (!runHelpTrigger) return
    onRunHelpTriggerConsumed()
    void (async () => {
      try {
        const now = Date.now()
        const next = await withRecordLock(async () => {
          const stored = runHelpTrigger.targetChatId
            ? await offlineManager.getConversation(runHelpTrigger.targetChatId)
            : null
          const base: Conversation = stored ?? {
            // A chat dir without a conversation record (deleted record,
            // external dir) adopts the dir's id, keeping the
            // conversation↔directory invariant.
            id: runHelpTrigger.targetChatId ?? now.toString(),
            title: '',
            messages: [],
            createdAt: now,
            updatedAt: now,
            isOffline: true
          }
          const updated = appendUserMessage(base, {
            id: now.toString(),
            content: runHelpTrigger.text,
            now,
            runHelp: { chatId: runHelpTrigger.toolsChatId }
          })
          await offlineManager.saveConversation(updated)
          return updated
        })
        setActiveConversation(next)
        setSendError(null)
        void processQueue(next.id)
      } catch (error) {
        // The trigger is already consumed: a local failure must surface,
        // not vanish (the typed text is lost, so say so plainly). convId
        // null: the view may never have switched to the target chat.
        setSendError({
          convId: null,
          message: `Could not save the Ask AI request locally: ${(error as Error).message}`
        })
      }
    })()
  }, [runHelpTrigger])

  // The armed run.json skill rides every request as a system message
  // (request-only, never persisted); the ref keeps the serial queue's
  // closure fresh.
  const runSkillArmedRef = useRef(runSkillArmed)
  useEffect(() => {
    runSkillArmedRef.current = runSkillArmed
  }, [runSkillArmed])

  // Reload the webview after an in-app auth popup returns to the app origin,
  // so the logged-in UI replaces the login screen.
  useEffect(() => {
    const unsubscribe = window.api?.onAuthPopupFinished?.(() => {
      webviewRef.current?.reload()
    })
    return () => unsubscribe?.()
  }, [])

  // Shared online transition: a brief 'checking', then online. A loaded SPA
  // self-heals reconnects — repeat transitions are instant, nothing spins.
  // A FAILED load (first or later) is wedged — the auto-retry only runs
  // while navigator.onLine — so the transition re-drives it here, the
  // single reload path for the online case.
  const goOnlineTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const goOnline = useCallback((): void => {
    setConnectionStatus('checking')
    const decision = decideOnlineTransition({
      hasWebview: webviewRef.current !== null,
      loadedOnce: loadedOnceRef.current,
      loadError,
      retryPending: retryTimeoutRef.current !== null
    })
    if (decision.reload) {
      setLoadError(null)
      setRetryCount(0)
    }
    if (decision.isLoading !== null) setIsLoading(decision.isLoading)
    if (decision.reload) webviewRef.current?.reload()
    if (goOnlineTimeoutRef.current) clearTimeout(goOnlineTimeoutRef.current)
    goOnlineTimeoutRef.current = setTimeout(() => {
      goOnlineTimeoutRef.current = null
      setConnectionStatus('online')
      setLoadError(null)
      setRetryCount(0)
    }, 1000)
  }, [loadError])

  // Network status monitoring
  useEffect(() => {
    const handleOffline = (): void => {
      // A real flap cancels the pending transition, or a stale 'online'
      // would land after the network is already gone.
      if (goOnlineTimeoutRef.current) {
        clearTimeout(goOnlineTimeoutRef.current)
        goOnlineTimeoutRef.current = null
      }
      setConnectionStatus('offline')
      setIsLoading(false)
    }

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', handleOffline)

    const checkInterval = setInterval(() => {
      if (navigator.onLine && connectionStatus === 'offline') {
        goOnline()
      }
    }, 5000)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(checkInterval)
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [connectionStatus, goOnline])

  const showOfflineView = isOffline || connectionStatus === 'offline'

  // First transition out of the offline view mounts the (lazy) webview;
  // afterwards it stays mounted and only CSS-hidden. Gated on settingsReady:
  // before the forced-offline flag arrives, showOfflineView is unreliable.
  useEffect(() => {
    if (settingsReady && !showOfflineView) setWebviewMounted(true)
  }, [settingsReady, showOfflineView])

  // Route stream events to the active request: content deltas accumulate
  // into the provisional bubble; done/error settle the queue's parked
  // promise. The serial queue means at most one stream is active; events
  // for a stale requestId (an already-settled stream's tail) are dropped.
  useEffect(() => {
    const unsubscribe = window.api?.onKimiApiStreamEvent?.((event) => {
      const active = streamRef.current
      if (!active || event.requestId !== active.requestId) return
      if (event.type === 'delta') {
        active.text += event.content
        setStreamingText(active.text)
        return
      }
      const waiter = streamWaitersRef.current.get(event.requestId)
      streamWaitersRef.current.delete(event.requestId)
      if (event.type === 'done') {
        waiter?.resolve({
          aborted: event.aborted,
          dispatched: event.dispatched ?? true,
          text: active.text
        })
      } else {
        waiter?.reject(new Error(event.message))
      }
    })
    return unsubscribe
  }, [])

  // Serial send queue. Each pass reads the stored record fresh, sends the
  // full history (each message exactly once) and, on success, marks exactly
  // the sent messages 'synced' and appends the reply — re-read before
  // writing, so a message queued while the request was in flight is neither
  // lost nor re-sent. The reply streams: deltas grow a provisional bubble,
  // and only the completed text persists (one write, same as before).
  // Failures leave messages 'pending': the next send or the network coming
  // back retries them.
  const processQueue = useCallback(async (conversationId: string): Promise<void> => {
    if (processingRef.current) {
      pendingConvIdsRef.current.add(conversationId)
      return
    }
    processingRef.current = true
    setIsGenerating(true)
    setQueueConvId(conversationId)
    let failed = false
    try {
      for (;;) {
        const current = await offlineManager.getConversation(conversationId)
        if (!current) break
        const pending = pendingUserMessages(current)
        if (pending.length === 0) break

        const status = await window.api?.oauthStatus?.()
        const model = status?.selectedModel || status?.models?.[0]?.id
        if (!model) {
          setSendError({
            convId: conversationId,
            message: 'No model available. Please log in again.'
          })
          failed = true
          break
        }

        const apiMessages = toApiMessages(current.messages)
        // AI run-help: a conversation holding a trigger gets the tool loop
        // AND the skill on every request — follow-ups keep tool access and
        // the freshness rules (the API is stateless; the marker carries the
        // tools' chat directory).
        const { toolsChatId } = runHelpPassInfo(current.messages)
        const requestId = `chat-stream-${Date.now()}-${++streamCounterRef.current}`
        streamRef.current = { requestId, text: '' }
        setStreamingText('')
        // Park before starting: the done/error event settles this promise.
        const outcomePromise = new Promise<{
          aborted: boolean
          dispatched: boolean
          text: string
        }>((resolve, reject) => {
          streamWaitersRef.current.set(requestId, { resolve, reject })
        })
        // 3.9.4: a missing chat dir is accepted (the tools bootstrap it on
        // the first write), so there is no degrade-to-plain retry here —
        // a start failure surfaces as the request error. The buffers push
        // makes the tools read the live editor drafts of this chat, not
        // the stale disk — a fresh snapshot per pass.
        let startResult: { success: boolean; error?: string; code?: string } | undefined
        try {
          startResult = await window.api?.kimiApiStreamStart?.({
            requestId,
            body: {
              model,
              messages: [
                ...(toolsChatId ? [{ role: 'system', content: RUN_HELP_SKILL }] : []),
                ...(runSkillArmedRef.current ? [{ role: 'system', content: RUN_JSON_SKILL }] : []),
                ...apiMessages
              ]
            },
            ...(toolsChatId
              ? { runHelp: { chatId: toolsChatId, buffers: collectRunHelpBuffers(toolsChatId) } }
              : {})
          })
        } catch (error) {
          // A start that throws must not orphan the parked waiter.
          streamWaitersRef.current.delete(requestId)
          throw error
        }
        if (!startResult?.success) {
          streamWaitersRef.current.delete(requestId)
          streamRef.current = null
          setStreamingText('')
          setSendError({
            convId: conversationId,
            message: startResult?.error || 'Failed to start the request'
          })
          failed = true
          break
        }
        setStreamActive(true)

        const outcome = await outcomePromise

        // Stopped before the request went out (main was still preparing it):
        // nothing was delivered, so nothing is marked — the messages stay
        // queued for the next send, and there is no reply to persist.
        if (outcome.aborted && !outcome.dispatched) break

        // An empty completed reply is not a reply (abort is handled below).
        if (!outcome.aborted && outcome.text.length === 0) {
          setSendError({ convId: conversationId, message: 'Unexpected API response' })
          failed = true
          break
        }

        const sentIds = pending.map((m) => m.id)
        const next = await withRecordLock(async () => {
          const fresh = await offlineManager.getConversation(conversationId)
          if (!fresh) return null
          // A user-stopped stream keeps whatever text had arrived (real
          // model output); stopped before the first delta, there is no
          // reply to append — the sent messages are still delivered.
          const updated =
            outcome.aborted && outcome.text.length === 0
              ? markSentSynced(fresh, sentIds, Date.now())
              : applyAssistantReply(fresh, sentIds, {
                  id: (Date.now() + 1).toString(),
                  content: outcome.text,
                  now: Date.now()
                })
          await offlineManager.saveConversation(updated)
          return updated
        })
        if (!next) break
        setSendError((prev) => (prev && prev.convId === conversationId ? null : prev))
        if (conversationRef.current?.id === conversationId) {
          setActiveConversation(next)
        }
        // Cleared only after the persist above: same microtask → React
        // batches, so the provisional bubble swaps to the persisted reply
        // with no typing-indicator flash in between.
        streamRef.current = null
        setStreamingText('')
        setStreamActive(false)
      }
    } catch (error) {
      setSendError({ convId: conversationId, message: (error as Error).message })
      failed = true
    } finally {
      processingRef.current = false
      setIsGenerating(false)
      setQueueConvId(null)
      // Safety net for the error/break paths: a settled stream never leaks
      // into the next pass (the normal path clears these at the pass's end).
      streamRef.current = null
      setStreamingText('')
      setStreamActive(false)
      // Flushes dropped by the guard above wait in the set; hand the queue
      // to the next one — its own finally continues the chain. A failed
      // pass deletes only its own id: a persistent failure must not
      // retry-storm, but other conversations' flushes still run.
      if (failed) {
        pendingConvIdsRef.current.delete(conversationId)
      }
      const nextId = pendingConvIdsRef.current.values().next().value
      if (nextId !== undefined) {
        pendingConvIdsRef.current.delete(nextId)
        void processQueue(nextId)
      }
    }
  }, [])

  // Flush queued messages when the network (or the viewed conversation)
  // makes delivery possible again.
  useEffect(() => {
    if (
      connectionStatus === 'online' &&
      activeConversation &&
      pendingUserMessages(activeConversation).length > 0
    ) {
      void processQueue(activeConversation.id)
    }
  }, [connectionStatus, activeConversation, processQueue])

  // The send button turns into stop while this chat's reply generates; the
  // partial text already streamed is kept (see the queue's abort handling).
  const handleStopGenerating = (): void => {
    const active = streamRef.current
    if (!active) return
    // Best-effort: the stream settles via its own events even if the
    // invoke itself fails, so a rejection here is safe to swallow.
    void window.api?.kimiApiStreamAbort?.(active.requestId)?.catch(() => {})
  }

  // Handle webview load events, keyed on the element itself: whenever a
  // webview (re)mounts — offline boot transition, error-UI reload, surface
  // switch — the listeners attach to the live element; without this,
  // did-finish-load never clears the spinner on the fresh element.
  useEffect(() => {
    const webview = webviewEl
    if (!webview) return

    const handleDidFinishLoad = (): void => {
      loadedOnceRef.current = true
      // A pending auto-retry must not reload the now-healthy page later.
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      setIsLoading(false)
      setLoadError(null)
      setRetryCount(0)
    }

    const handleDidFailLoad = (event: WebviewDidFailLoadEvent): void => {
      if (event.errorCode !== -3) {
        console.error('Webview failed to load:', event.errorDescription)
        setLoadError(event.errorDescription)
        setIsLoading(false)

        if (retryCount < 3 && navigator.onLine) {
          retryTimeoutRef.current = setTimeout(
            () => {
              setRetryCount((prev) => prev + 1)
              setIsLoading(true)
              webview.reload()
            },
            3000 * (retryCount + 1)
          )
        }
      }
    }

    const handleConsoleMessage = (event: WebviewConsoleMessageEvent): void => {
      if (event.level === 3) {
        console.error('Webview console error:', event.message)
      }
    }

    webview.addEventListener('did-finish-load', handleDidFinishLoad)
    webview.addEventListener('did-fail-load', handleDidFailLoad as EventListener)
    webview.addEventListener('console-message', handleConsoleMessage as EventListener)

    return () => {
      webview.removeEventListener('did-finish-load', handleDidFinishLoad)
      webview.removeEventListener('did-fail-load', handleDidFailLoad as EventListener)
      webview.removeEventListener('console-message', handleConsoleMessage as EventListener)
    }
  }, [webviewEl, retryCount])

  // Handle navigation from main process
  useEffect(() => {
    const handleNavigate = (path: string): void => {
      const webview = webviewRef.current
      if (webview && path !== 'settings') {
        const url = path.startsWith('http') ? path : `https://www.kimi.ai${path}`
        webview.src = url
      }
    }

    const unsubscribe = window.api?.onNavigateTo?.(handleNavigate)
    return () => unsubscribe?.()
  }, [])

  // Auto-grow the multiline input up to a few lines.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [inputValue])

  // "Try Reconnecting" (offline view) / "Reload Page" (error surface).
  // Online, goOnline re-drives a failed load itself — the single reload
  // path, so a click cannot double-reload. Offline, an explicit reload is
  // the only honest feedback a click can give (it will fail and re-show
  // the error surface).
  const handleRetry = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    setRetryCount(0)
    if (navigator.onLine) {
      goOnline()
      return
    }
    setLoadError(null)
    if (webviewRef.current) {
      setIsLoading(true)
      webviewRef.current.reload()
    }
  }, [goOnline])

  // Queue the message as 'pending' and let the serial queue deliver it. The
  // input is never blocked: typing and queueing work while a reply is
  // pending.
  const handleSendMessage = async (): Promise<void> => {
    if (sendingRef.current) return
    const text = inputValue.trim()
    if (!text) return

    if (!hasSession) {
      onAuthRequired()
      return
    }

    sendingRef.current = true
    try {
      const now = Date.now()
      const next = await withRecordLock(async () => {
        const stored = activeConversation
          ? await offlineManager.getConversation(activeConversation.id)
          : null
        const base: Conversation = stored ?? {
          id: now.toString(),
          title: '',
          messages: [],
          createdAt: now,
          updatedAt: now,
          isOffline: true
        }
        const updated = appendUserMessage(base, { id: now.toString(), content: text, now })
        await offlineManager.saveConversation(updated)
        return updated
      })

      setActiveConversation(next)
      setInputValue('')
      setSendError(null)
      void processQueue(next.id)
    } catch {
      // The append never landed: keep the typed text and say so.
      setSendError({
        convId: activeConversation?.id ?? null,
        message: 'Could not save the message locally'
      })
    } finally {
      sendingRef.current = false
    }
  }

  // Start new conversation
  const handleNewConversation = (): void => {
    setActiveConversation(null)
    setInputValue('')
    setSendError(null)
  }

  // Copy the raw markdown source of an assistant answer through the
  // clipboard bridge; the ✓/✗ swap is the action's feedback (a silent
  // no-op would violate the feedback rule). Both settle paths re-arm the
  // reset, so a stale timer from an earlier copy cannot wipe a fresh ✗.
  const finishCopy = (id: string, ok: boolean): void => {
    setCopyState({ id, ok })
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyState(null), 1500)
  }

  const handleCopyMessage = (msg: { id: string; content: string }): void => {
    void window.api
      ?.clipboardWrite('text', msg.content)
      .then((result) => finishCopy(msg.id, !!result?.success))
      .catch(() => finishCopy(msg.id, false))
  }

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [])

  const allMessages = activeConversation?.messages ?? []
  // Queue activity is keyed by conversation: a reply generating for another
  // chat must not show a typing indicator or an error under this one's
  // messages.
  const queueBusyHere =
    isGenerating && queueConvId !== null && queueConvId === activeConversation?.id
  // The stop affordance is per-conversation like the bubble: viewing chat B
  // while chat A's reply streams must not offer to abort A's stream.
  const streamLiveHere = streamActive && queueBusyHere
  const visibleSendError =
    sendError && (sendError.convId === null || sendError.convId === activeConversation?.id)
      ? sendError
      : null

  const viewedConvId = activeConversation?.id ?? null
  const lastMessageId = allMessages[allMessages.length - 1]?.id ?? null
  const lastMessageRole = allMessages[allMessages.length - 1]?.role ?? null

  // Opening a conversation — or returning to the offline view — lands on
  // the latest message and re-arms stick-to-bottom. Layout effect: scroll
  // happens before paint, so the list never flashes its top.
  useLayoutEffect(() => {
    stickToBottomRef.current = true
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [viewedConvId, showOfflineView])

  // Bring new content into view: always for the user's own just-sent
  // message, otherwise only while stuck to the bottom. List growth comes
  // from appends and from the streaming bubble's growing text.
  useLayoutEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const isNewLastMessage = lastMessageId !== prevLastMessageIdRef.current
    prevLastMessageIdRef.current = lastMessageId
    if (stickToBottomRef.current || (isNewLastMessage && lastMessageRole === 'user')) {
      el.scrollTop = el.scrollHeight
    }
  }, [viewedConvId, showOfflineView, lastMessageId, lastMessageRole, queueBusyHere, streamingText])

  const handleMessagesScroll = (): void => {
    const el = messagesRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }

  // Offline view
  const offlineView = showOfflineView ? (
    <div className="offline-chat-view">
      <div className="offline-header">
        <div className="header-left">
          <h2>{activeConversation?.title || 'New Conversation'}</h2>
          {allMessages.length > 0 && (
            <span className="message-count">{allMessages.length} messages</span>
          )}
        </div>
        <div className="offline-badges">
          {runSkillArmed && (
            <button
              className="skill-chip"
              onClick={onDisarmRunSkill}
              title="run.json skill attached to outgoing messages — click to detach"
            >
              run.json skill ×
            </button>
          )}
          {activeConversation && (
            <button
              className="artifacts-btn"
              onClick={() => onOpenArtifacts(activeConversation)}
              title="Open this chat's artifacts in the editor"
            >
              📁 Artifacts
            </button>
          )}
          <span className="offline-badge">Offline Mode</span>
          {hasSession && <span className="api-ready">Kimi Code Ready</span>}
        </div>
      </div>

      <div
        className="messages-container"
        ref={messagesRef}
        onScroll={handleMessagesScroll}
        role="log"
        aria-busy={queueBusyHere}
      >
        {allMessages.length === 0 ? (
          <div className="empty-chat">
            <div className="empty-icon">💬</div>
            <p>No messages yet</p>
            <p className="empty-subtitle">Type a message to start a conversation</p>
          </div>
        ) : (
          allMessages.map((msg) => (
            <div
              key={msg.id}
              className={`message ${msg.role}`}
              role="article"
              aria-label={msg.role === 'user' ? 'user message' : 'assistant message'}
            >
              <div className="message-avatar">{msg.role === 'user' ? '👤' : '🤖'}</div>
              <div className="message-content">
                {msg.role === 'assistant' ? (
                  <ChatMarkdown content={msg.content} />
                ) : (
                  <div className="message-text">{msg.content}</div>
                )}
                <div className="message-time">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                  {msg.role === 'assistant' && (
                    <button
                      className="copy-btn"
                      onClick={() => handleCopyMessage(msg)}
                      title="Copy answer (markdown source)"
                      aria-label={
                        copyState?.id === msg.id
                          ? copyState.ok
                            ? 'Copied'
                            : 'Copy failed'
                          : 'Copy answer'
                      }
                    >
                      {copyState?.id === msg.id ? (copyState.ok ? '✓' : '✗') : '⧉'}
                    </button>
                  )}
                  {msg.role === 'user' && msg.syncStatus === 'pending' && (
                    <span className="pending"> (queued)</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}

        {queueBusyHere && streamingText.length === 0 && (
          <div className="message assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        {queueBusyHere && streamingText.length > 0 && (
          <div className="message assistant" role="article" aria-label="assistant message">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <ChatMarkdown content={streamingText} />
            </div>
          </div>
        )}
      </div>

      {visibleSendError && (
        <div className="send-error">
          <span>
            ⚠️ {visibleSendError.message} Queued messages retry on the next send or reconnect.
          </span>
          <button className="send-error-dismiss" onClick={() => setSendError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="input-area">
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void handleSendMessage()
            }
          }}
          placeholder={
            hasSession
              ? 'Type your message... (Shift+Enter for a new line)'
              : 'Log in with your Kimi account in settings to chat'
          }
          rows={1}
        />
        <button
          onClick={streamLiveHere ? handleStopGenerating : handleSendMessage}
          disabled={!streamLiveHere && (queueBusyHere || !inputValue.trim() || !hasSession)}
          className="send-btn"
          aria-label={
            streamLiveHere ? 'Stop generating' : queueBusyHere ? 'Generating…' : 'Send message'
          }
          title={
            streamLiveHere
              ? 'Stop generating (the partial reply is kept)'
              : queueBusyHere
                ? 'Generating…'
                : 'Send'
          }
        >
          {streamLiveHere ? '■' : queueBusyHere ? '⏳' : '➤'}
        </button>
      </div>

      <div className="offline-notice">
        <p>
          {forceOffline
            ? 'Offline mode is forced — flip the title bar toggle (or Settings → Advanced) to return to the webview. Messages are still saved locally.'
            : hasSession
              ? "You're in offline mode. Messages are saved locally and will persist."
              : 'Log in with your Kimi account (Settings → Kimi Account) to enable chat functionality.'}
        </p>
        <div className="notice-actions">
          <button className="btn-secondary" onClick={handleNewConversation}>
            📝 New Chat
          </button>
          {!forceOffline && (
            <button className="btn-primary" onClick={handleRetry}>
              🔄 Try Reconnecting
            </button>
          )}
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="webview-container">
      {offlineView}

      {webviewMounted && (
        <div className="webview-surface" style={{ display: showOfflineView ? 'none' : 'flex' }}>
          {isLoading && !loadError && (
            <LoadingSkeleton
              status={connectionStatus === 'checking' ? 'Reconnecting...' : 'Loading Kimi...'}
              retryCount={retryCount}
            />
          )}

          {loadError && !isLoading && (
            <div className="error-container">
              <div className="error-content">
                <div className="error-icon">⚠️</div>
                <h2>Failed to Load</h2>
                <p className="error-message">{loadError}</p>
                {retryCount > 0 && <p className="retry-count">Retry attempt {retryCount}/3</p>}

                <div className="error-actions">
                  <button className="btn-primary" onClick={handleRetry}>
                    Reload Page
                  </button>
                  <button className="btn-secondary" onClick={() => window.api?.restartApp?.()}>
                    Restart App
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* eslint-disable react/no-unknown-property */}
          <webview
            ref={attachWebview}
            src="https://www.kimi.ai"
            // allowpopups must be present at guest-attach time: a webview that
            // gains the attribute later still drops every window.open from the
            // guest (observed Electron 39) — the login popup never surfaces.
            // Runtime wants a string (React drops boolean true for non-boolean
            // attributes); @types/react declares boolean — cast to satisfy TS.
            allowpopups={'true' as unknown as boolean}
            className="kimi-webview"
            partition="persist:kimi"
            webpreferences="contextIsolation=yes, nodeIntegration=no, allowRunningInsecureContent=no, javascript=yes, plugins=no, experimentalFeatures=no"
            useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 KimiDesktop/1.0"
          />
          {/* eslint-enable react/no-unknown-property */}
        </div>
      )}
    </div>
  )
}
