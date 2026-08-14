/**
 * Shared chat engine for every in-product conversation surface.
 *
 * Both the agent test drawer and the chat app page run on this hook, so streaming
 * behaviour, attachment handling, queue fallback and error recovery stay identical
 * between them — fixing one fixes both.
 *
 * The only difference between the surfaces is the `channel` marker, which the API
 * records as the run's trigger source so chat-app traffic stays separable from
 * in-product test conversations in run history and stats.
 */

import { isAttachmentImageExt } from '@a2wave/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StreamLogEntry } from '@/hooks/use-agents'
import { useAgentChats, useChatMessages } from '@/hooks/use-chat-history'
import { useAttachmentConfig } from '@/hooks/use-settings'
import { api } from '@/lib/api'
import { historyRefToSentAttachment } from '@/lib/attachments'
import {
  createIdleWatchdog,
  type IdleWatchdog,
  interpretStreamEnd,
  SseEventAccumulator,
} from '@/lib/sse-stream'

/** An attachment being composed or already uploaded (local UI state). */
export interface PendingAttachment {
  localId: string
  name: string
  mimeType: string
  size: number
  /** Local image preview URL (URL.createObjectURL); empty for non-images. */
  previewUrl?: string
  /** Server token, present once the upload succeeded. */
  token?: string
  uploading: boolean
  error?: string
}

/** An attachment already sent with a message, kept for in-conversation rendering. */
export interface SentAttachment {
  name: string
  mimeType: string
  previewUrl?: string
}

export interface ChatMessageItem {
  role: 'user' | 'agent'
  content: string
  runId?: string
  attachments?: SentAttachment[]
  /** Marks a bubble that failed, so the UI can offer a retry affordance. */
  failed?: boolean
}

export interface UseAgentChatOptions {
  agentId: string | undefined
  /** Gate sending; the caller supplies the reason shown to the user. */
  canChat: boolean
  disabledReason?: string | null
  /** Which surface is sending — recorded as the run's trigger source. */
  channel?: 'debug' | 'chat_app'
  /** Load prior conversations on mount. The chat app page opts out for a clean start. */
  loadHistory?: boolean
}

/**
 * Abort the chat stream if no chunk arrives within this window. Generous enough
 * to tolerate a slow agent CLI thinking between tokens, tight enough to not spin
 * forever when the backend silently dies after sending headers.
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000

/** Poll cadence for a run that is queued or running behind the stream. */
const RUN_POLL_INTERVAL_MS = 2000

/**
 * Follow-up refreshes for the memory list after a turn completes.
 *
 * Interactive writes are visible at `done`; automatic worklog/insight extraction
 * starts afterward and stays non-blocking. Two bounded refreshes cover typical
 * and slow background completions without continuous polling.
 */
const MEMORY_BACKGROUND_REFRESH_DELAYS_MS = [20_000, 60_000] as const

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/**
 * Why the hook is currently reading a run's transcript from the server.
 *
 * This is an explicit intent, not a condition inferred from streaming/run status.
 * Inferring it was the source of a long tail of bugs: the same snapshot must be
 * adopted when restoring a conversation or catching up on a queued run, but
 * REFUSED when it would clobber bubbles the client itself is currently rendering,
 * and those cases are not distinguishable from `isStreaming` + run status alone.
 *
 * - `idle`    — nothing to adopt; the in-memory transcript is authoritative.
 * - `restore` — showing a previously-saved conversation; the server is the truth.
 * - `awaitRun`— following a specific run whose reply can only arrive by polling
 *               (the queued path). Carries the run id so a stale poll for an
 *               earlier run can never be mistaken for the one being followed.
 */
export type TranscriptSource =
  | { kind: 'idle' }
  | { kind: 'restore'; runId: string }
  | { kind: 'awaitRun'; runId: string }

/**
 * Whether a freshly-fetched transcript for `fetchedRunId` should replace the
 * in-memory one.
 *
 * Adopting unconditionally lets a completed turn's round-trip overwrite live
 * bubbles and revoke the blob URLs behind their thumbnails. Refusing
 * unconditionally strands a queued turn. The run id must match, otherwise a poll
 * still in flight for a previous run can overwrite the turn now on screen.
 */
export function shouldAdoptServerTranscript(
  source: TranscriptSource,
  fetchedRunId: string | undefined,
): boolean {
  if (source.kind === 'idle') return false
  // Both kinds are run-id scoped. `restore` stays armed across polls (its run may
  // still be executing), so without the id check a poll for the restored run could
  // overwrite the live bubbles of a NEW turn the user sent in the meantime.
  return !!fetchedRunId && fetchedRunId === source.runId
}

/** Apply a patch to the trailing agent bubble — the streaming placeholder. */
function patchLastAgentMessage(
  messages: ChatMessageItem[],
  update: Partial<ChatMessageItem>,
): ChatMessageItem[] {
  const updated = [...messages]
  const last = updated.length - 1
  if (last >= 0 && updated[last].role === 'agent') {
    updated[last] = { ...updated[last], ...update }
  }
  return updated
}

/** Stamp the run id onto the most recent user bubble that doesn't have one yet. */
function patchLastUserRunId(messages: ChatMessageItem[], runId: string): ChatMessageItem[] {
  const updated = [...messages]
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === 'user' && !updated[i].runId) {
      updated[i] = { ...updated[i], runId }
      break
    }
  }
  return updated
}

export function useAgentChat({
  agentId: id,
  canChat,
  disabledReason,
  channel = 'debug',
  loadHistory = true,
}: UseAgentChatOptions) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [messages, setMessages] = useState<ChatMessageItem[]>([])
  const [chatInput, setChatInput] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [chatId, setChatId] = useState<string | undefined>()
  const [chatError, setChatError] = useState<string | null>(null)
  const [currentRunId, setCurrentRunId] = useState<string | undefined>()
  /**
   * Run id of a queued turn we are polling for, mirrored into state so the UI can
   * react. `transcriptSourceRef` stays the authority for the adoption decision
   * (it must be readable synchronously inside the effect); this is purely the
   * render-visible copy that keeps the composer disabled and Stop mounted.
   */
  const [followedRunId, setFollowedRunId] = useState<string | undefined>()
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [streamLogs, setStreamLogs] = useState<StreamLogEntry[]>([])

  // Every object URL created here is tracked so it can be revoked on unmount or
  // when the messages holding it are discarded — sent previews live on in
  // `messages`, so they must not be revoked at send time.
  const objectUrlsRef = useRef<Set<string>>(new Set())
  // Mirror of `messages` so the adoption effect can diff against the outgoing
  // transcript without reading it through a state updater (see the revoke logic).
  const messagesRef = useRef<ChatMessageItem[]>([])
  const abortControllerRef = useRef<AbortController | null>(null)
  // Pending memory-refresh timers, tracked so unmounting cancels them rather than
  // invalidating queries for a surface that is gone.
  const memoryRefreshTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  // Run id of the turn currently in flight. The SSE `done`/`queued` events are the
  // only place it surfaces, so it is captured here as soon as either arrives —
  // Stop needs it to cancel the server-side run, which keeps executing otherwise.
  const activeRunIdRef = useRef<string | undefined>(undefined)
  // Why we are reading a transcript from the server right now. Held in a ref
  // because the deciding poll is the one where the run status has *already*
  // flipped to a terminal value, so a render-time value would be a tick late.
  const transcriptSourceRef = useRef<TranscriptSource>({ kind: 'idle' })

  const { data: agentChats, refetch: refetchChats } = useAgentChats(loadHistory ? id : undefined)
  const {
    data: chatHistoryData,
    refetch: refetchMessages,
    isFetching: chatHistoryFetching,
    isError: chatHistoryError,
  } = useChatMessages(id, currentRunId)
  const attachmentConfig = useAttachmentConfig()

  /**
   * Reset everything when the Agent changes.
   *
   * The hook can outlive one Agent: the detail route stays mounted while `id`
   * switches. Without this, Agent A's messages, engine `chatId`, run handle and
   * `historyLoaded` latch all carried over — so B's history never restored, and a
   * message sent to B resumed A's engine session. Skips the very first render so
   * a fresh mount does not pointlessly clear its own initial state.
   */
  /**
   * Set when the user deliberately starts a fresh conversation, cleared once they
   * actually send something (at which point that conversation has its own run and
   * resuming would be plainly wrong anyway).
   *
   * Needed because "messages is non-empty" cannot tell a restored conversation
   * (safe to refresh over) from a blank one the user just opened (must not be
   * silently replaced by the newest session on reopen).
   */
  const userStartedFreshRef = useRef(false)
  const previousAgentIdRef = useRef<string | undefined>(id)
  useEffect(() => {
    if (previousAgentIdRef.current === id) return
    previousAgentIdRef.current = id
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeRunIdRef.current = undefined
    transcriptSourceRef.current = { kind: 'idle' }
    userStartedFreshRef.current = false
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current.clear()
    setMessages([])
    setPendingAttachments([])
    setChatInput('')
    setChatId(undefined)
    setChatError(null)
    setCurrentRunId(undefined)
    setFollowedRunId(undefined)
    setStreamLogs([])
    setIsStreaming(false)
    setHistoryLoaded(false)
  }, [id])

  // Resume the most recent conversation so reopening the surface keeps context.
  useEffect(() => {
    if (!loadHistory || historyLoaded || !agentChats) return
    if (agentChats.length > 0) {
      // Restoring: the server transcript is authoritative for THIS run. Scoped by
      // id so a poll for it can never overwrite a different, newer turn.
      const resumedRunId = agentChats[0].id
      transcriptSourceRef.current = { kind: 'restore', runId: resumedRunId }
      setCurrentRunId(resumedRunId)
      setFollowedRunId(resumedRunId)
      // Arming `followedRunId` mounts the Stop control for a still-executing
      // resumed run, so the handle it cancels with has to be armed too. Without
      // this, Stop wrote its "stopped" note and dropped the follow state while the
      // agent CLI kept running — holding a concurrency slot with its reply now
      // unreachable. Only the SSE paths set this otherwise, and a resumed run has
      // no stream.
      activeRunIdRef.current = resumedRunId
    }
    setHistoryLoaded(true)
  }, [agentChats, historyLoaded, loadHistory])

  // Read through refs so `refreshHistory`'s identity stays stable. Depending on
  // `isStreaming` directly re-created the callback on every stream transition,
  // re-firing the drawer's `useEffect([open, refreshHistory])` at the end of each
  // turn and force-resuming whatever conversation was newest.
  const isTurnActiveRef = useRef(false)
  // Mirrors "a turn is in progress", which includes a queued run whose stream has
  // already closed — refusing on raw `isStreaming` alone would let a drawer reopen
  // replace the conversation the user is still waiting on.
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  /**
   * Re-read the session list and resume whatever is newest now.
   *
   * The drawer stays mounted for the whole page, so without this it would latch
   * onto the conversation that was newest at page load and silently resume that
   * stale one on every reopen. Releasing `historyLoaded` re-arms the resume effect.
   *
   * Refuses only when refreshing would destroy something the user would miss: a
   * turn in flight, or a blank conversation they deliberately opened via "New
   * conversation". A merely restored conversation IS refreshed — that is the whole
   * point, and gating on "messages is non-empty" would refuse every reopen after
   * the first, reintroducing the stale-resume bug this exists to fix.
   */
  const refreshHistory = useCallback(() => {
    if (!loadHistory) return
    if (isTurnActiveRef.current || userStartedFreshRef.current) return
    // Re-arm the resume effect only AFTER the refetch lands. Releasing the latch
    // first would let the effect run synchronously against the still-cached list
    // and re-latch on the stale newest session — the exact staleness this exists
    // to clear. Tolerates a non-promise return so the caller is not coupled to
    // the query client's exact refetch signature.
    void Promise.resolve(refetchChats()).finally(() => setHistoryLoaded(false))
  }, [loadHistory, refetchChats])

  useEffect(() => {
    if (currentRunId && id) {
      queryClient.invalidateQueries({ queryKey: ['agents', id, 'chats', currentRunId, 'messages'] })
    }
  }, [currentRunId, id, queryClient])

  // A queued turn gets a single `queued` SSE event and nothing more, so the run's
  // eventual output only arrives via polling.
  const runStatus = chatHistoryData?.run?.status
  const isRunPending = runStatus === 'running' || runStatus === 'pending' || runStatus === 'queued'

  useEffect(() => {
    if (!isRunPending) return
    const timer = setInterval(() => refetchMessages(), RUN_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isRunPending, refetchMessages])

  // Release valve. Both automatic clear points below sit behind "we have data", so
  // a run whose transcript can never be read (agent deleted, run purged, the query
  // erroring out) would otherwise leave `followedRunId` set forever — and with it a
  // permanently disabled composer that only a page reload could recover.
  useEffect(() => {
    if (!chatHistoryError) return
    // Release only what would otherwise stick: the render-visible follow state that
    // keeps the composer disabled. The transcript INTENT survives, so a transient
    // failure (network blip, API restart) does not permanently blank a restored
    // conversation — downgrading it to `idle` was one-way, and nothing re-arms it,
    // so the retry that succeeds afterwards would be refused and the user would sit
    // on an empty screen until reload.
    //
    // `activeRunIdRef` is likewise left alone: this query can be reading an OLDER
    // run than the one in flight, so clearing it would strip Stop's ability to
    // cancel a perfectly healthy turn just because a stale query happened to error.
    setFollowedRunId(undefined)
  }, [chatHistoryError])

  // Re-arm after recovery. The valve above releases the follow state so a dead
  // query cannot freeze the composer — but if polling comes back and the run is
  // STILL executing, that release was premature: Stop would stay hidden and the
  // composer enabled, so the next send would cancel the live run as "superseded".
  // The transcript intent survived the error, so it still says which run this is.
  useEffect(() => {
    if (chatHistoryError || !isRunPending) return
    const source = transcriptSourceRef.current
    if (source.kind === 'idle') return
    if (chatHistoryData?.run?.id !== source.runId) return
    setFollowedRunId((prev) => prev ?? source.runId)
  }, [chatHistoryError, chatHistoryData, isRunPending])

  useEffect(() => {
    if (!chatHistoryData) return
    if (!shouldAdoptServerTranscript(transcriptSourceRef.current, chatHistoryData.run?.id)) {
      // Not the run we are following. If the followed run can no longer be reached
      // through this query at all (the conversation moved on), stop following it —
      // otherwise `followedRunId` sticks and the composer stays disabled forever.
      const source = transcriptSourceRef.current
      if (source.kind !== 'idle' && chatHistoryData.run?.id && currentRunId !== source.runId) {
        transcriptSourceRef.current = { kind: 'idle' }
        setFollowedRunId(undefined)
      }
      return
    }
    // A message-less run only carries something worth rendering when it FAILED —
    // `run.result.error` is then the sole record of what happened. In every other
    // case (still pending, or settled successfully with no rows) there is nothing
    // to adopt, and falling through would `setMessages([])` and blank whatever the
    // user is looking at.
    // Deliberately overlaps with `failureText`'s own status check below. Either one
    // alone prevents a completed run from fabricating an error bubble, and mutation
    // testing shows removing just one keeps the tests green — that redundancy is
    // intentional defence on a path that has regressed repeatedly, not dead code.
    const settledFailure =
      chatHistoryData.run.status === 'failed' || chatHistoryData.run.status === 'cancelled'
    if (chatHistoryData.messages.length === 0 && !settledFailure) {
      if (!isRunPending) {
        transcriptSourceRef.current = { kind: 'idle' }
        setFollowedRunId(undefined)
      }
      return
    }

    // While a FOLLOWED run is pending the server transcript holds only the user row
    // — the agent row is written at completion — so adopting it would delete the
    // pending placeholder and leave no indicator at all.
    //
    // `restore` is the opposite case: the screen is empty, so it must adopt even a
    // pending run's partial transcript or the user sees a blank conversation. It
    // adopts once and immediately drops to `idle` below, so it cannot re-adopt (and
    // re-revoke blob URLs) on subsequent polls.
    if (transcriptSourceRef.current.kind === 'awaitRun' && isRunPending) return

    // Release the intent only once the run has actually settled.
    //
    // `restore` must stay armed while its run is still executing: a conversation
    // resumed mid-run adopts a transcript that has the question but not yet the
    // answer, and dropping to `idle` there froze it that way forever — no reply, no
    // spinner, no error. Re-adopting each poll is safe here precisely because a
    // restored conversation holds nothing locally that a snapshot could clobber.
    if (!isRunPending) {
      // Release the handle for EITHER kind. The restore path arms it too (so Stop
      // can cancel a resumed in-flight run), and scoping this to `awaitRun` left a
      // settled restored run holding a live handle: another tab continuing that
      // conversation reuses the same row, and this tab's next Stop / New
      // conversation would fire `/runs/<id>/cancel` and kill the other tab's turn.
      const settledSource = transcriptSourceRef.current
      if (settledSource.kind !== 'idle' && activeRunIdRef.current === settledSource.runId) {
        activeRunIdRef.current = undefined
      }
      transcriptSourceRef.current = { kind: 'idle' }
      setFollowedRunId(undefined)
    }

    // A failed run writes NO agent chat row for the in-product channels (see
    // run-lifecycle: that write is gated on a native-chat receive_id), so adopting
    // its transcript verbatim would drop the placeholder and show the question with
    // no reply and no explanation. Surface the run's own recorded error instead.
    const runResult = chatHistoryData.run.result as Record<string, unknown> | null
    const failureText =
      chatHistoryData.run.status === 'failed' || chatHistoryData.run.status === 'cancelled'
        ? typeof runResult?.error === 'string' && runResult.error
          ? runResult.error
          : t('agentDetail.chatExecutionFailed')
        : null

    const restored: ChatMessageItem[] = chatHistoryData.messages.map((msg) => ({
      role: msg.role as 'user' | 'agent',
      content: msg.content,
      runId: msg.role === 'user' ? chatHistoryData.run.id : undefined,
      // Historical image previews point at the authenticated GET endpoint; once the
      // staging TTL lapses the UI degrades to a filename chip.
      ...(msg.attachments && msg.attachments.length > 0
        ? { attachments: msg.attachments.map(historyRefToSentAttachment) }
        : {}),
    }))
    // Append the failure only when the LAST turn went unanswered. A reused run row
    // accumulates every turn's messages, so "the transcript contains an agent row"
    // says nothing about the turn that just failed — checking that swallowed a
    // failed follow-up behind an earlier turn's successful reply. A trailing user
    // row is the reliable "this turn got no answer" signal.
    // The empty case counts too: a run that failed before writing any row has no
    // trailing user message, and returning nothing would render a blank page.
    if (failureText && (restored.length === 0 || restored[restored.length - 1]?.role === 'user')) {
      restored.push({
        role: 'agent',
        content: t('agentDetail.chatErrorPrefix', { message: failureText }),
        failed: true,
      })
    }
    // Reclaim only the blob URLs held by the messages being replaced. Revoking the
    // whole tracked set also killed previews of attachments still staged in the
    // composer, and — now that `restore` stays armed across polls — did so on every
    // 2s tick, so a user composing during a long run watched their thumbnails die.
    //
    // Done in the effect body, NOT inside a setMessages updater: the app runs under
    // StrictMode, which invokes updaters twice, and an updater that revokes URLs
    // and mutates a ref is a side effect that must not be replayed.
    const survivors = new Set<string>()
    for (const msg of restored) {
      for (const att of msg.attachments ?? []) {
        if (att.previewUrl) survivors.add(att.previewUrl)
      }
    }
    for (const msg of messagesRef.current) {
      for (const att of msg.attachments ?? []) {
        if (att.previewUrl && !survivors.has(att.previewUrl)) {
          URL.revokeObjectURL(att.previewUrl)
          objectUrlsRef.current.delete(att.previewUrl)
        }
      }
    }
    setMessages(restored)
    if (runResult?.chatId) setChatId(runResult.chatId as string)
  }, [chatHistoryData, currentRunId, isRunPending, t])

  useEffect(() => {
    const objectUrls = objectUrlsRef.current
    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.clear()
      // Read through the ref rather than a value captured at mount:
      // `refreshMemoryQueries` replaces the array with a filtered copy each time
      // a timer fires, so a captured reference goes stale after the first one and
      // every later timer would survive unmount, refetching for a dead surface.
      for (const timer of memoryRefreshTimersRef.current) clearTimeout(timer)
      memoryRefreshTimersRef.current = []
      // Deliberately does NOT cancel the server-side run.
      //
      // Unmount is not an instruction to abandon the turn: the test drawer keeps
      // this hook mounted (destroyOnClose={false}), and a user who navigates away
      // from the chat page usually expects to come back to the answer — the run is
      // recoverable from run history and from the conversation itself. Cancelling
      // here would silently destroy work the user still wants. Abandoning a live
      // run is an explicit action (Stop / New conversation), and both do cancel.
    }
  }, [])

  const revokeAllObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current.clear()
    setPendingAttachments([])
  }, [])

  /**
   * Abandon the in-flight turn: detach the client AND cancel the server run.
   *
   * Aborting the fetch alone leaves the agent CLI running to completion, holding
   * one of the agent's concurrency slots and burning provider tokens for output
   * nobody will ever read.
   */
  const abandonActiveRun = useCallback(() => {
    const runId = activeRunIdRef.current
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeRunIdRef.current = undefined
    // Stop following the abandoned run so no late poll can overwrite what the
    // caller renders next (the "stopped" note, or a fresh conversation).
    transcriptSourceRef.current = { kind: 'idle' }
    setFollowedRunId(undefined)
    if (runId) {
      // Best-effort: the run may already be terminal, in which case the API
      // rejects the cancel and there is nothing to report.
      api.post(`/runs/${runId}/cancel`, {}).catch(() => undefined)
    }
  }, [])

  /**
   * Refresh the memory list once now and twice on a delay: a turn's interactive
   * memory writes land by `done`, but worklog/insight extraction runs afterward
   * in the background, so an immediate-only refresh shows a stale list.
   */
  const refreshMemoryQueries = useCallback(() => {
    if (!id) return
    void queryClient.invalidateQueries({ queryKey: ['memories', id] })
    for (const delay of MEMORY_BACKGROUND_REFRESH_DELAYS_MS) {
      const timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['memories', id] })
        memoryRefreshTimersRef.current = memoryRefreshTimersRef.current.filter(
          (candidate) => candidate !== timer,
        )
      }, delay)
      memoryRefreshTimersRef.current.push(timer)
    }
  }, [id, queryClient])

  const startNewConversation = useCallback(() => {
    // Protects this blank conversation from being replaced by a reopen refresh.
    userStartedFreshRef.current = true
    abandonActiveRun()
    revokeAllObjectUrls()
    setMessages([])
    setChatId(undefined)
    setCurrentRunId(undefined)
    setChatError(null)
    setIsStreaming(false)
    setStreamLogs([])
  }, [abandonActiveRun, revokeAllObjectUrls])

  const uploadOne = useCallback(
    async (localId: string, file: File) => {
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await api.upload<{
          token: string
          name: string
          mimeType: string
          size: number
        }>('/attachments', formData)
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId ? { ...a, token: res.data.token, uploading: false } : a,
          ),
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('agentDetail.attachmentUploadFailed')
        setPendingAttachments((prev) =>
          prev.map((a) => (a.localId === localId ? { ...a, uploading: false, error: msg } : a)),
        )
      }
    },
    [t],
  )

  /** Validate against the admin-configured limits, build previews, upload each file. */
  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return
      let currentCount = pendingAttachments.length
      for (const file of Array.from(files)) {
        // Enforce the count cap here so an over-limit file is rejected before upload,
        // rather than after the composer has already been cleared on send.
        if (currentCount >= attachmentConfig.maxFilesPerRequest) {
          setChatError(t('agentDetail.attachmentTooMany'))
          break
        }
        const ext = extOf(file.name)
        if (!attachmentConfig.allowedExtensions.includes(ext)) {
          setChatError(t('agentDetail.attachmentInvalidType'))
          continue
        }
        if (file.size > attachmentConfig.maxFileSizeBytes) {
          setChatError(t('agentDetail.attachmentTooLarge'))
          continue
        }
        currentCount += 1
        const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        let previewUrl: string | undefined
        if (isAttachmentImageExt(ext)) {
          previewUrl = URL.createObjectURL(file)
          objectUrlsRef.current.add(previewUrl)
        }
        setPendingAttachments((prev) => [
          ...prev,
          {
            localId,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            previewUrl,
            uploading: true,
          },
        ])
        void uploadOne(localId, file)
      }
    },
    [attachmentConfig, pendingAttachments.length, t, uploadOne],
  )

  const removeAttachment = useCallback((localId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
        objectUrlsRef.current.delete(target.previewUrl)
      }
      return prev.filter((a) => a.localId !== localId)
    })
  }, [])

  const sendMessage = useCallback(
    async (rawMessage?: string) => {
      const trimmed = (rawMessage ?? chatInput).trim()
      // `isTurnActiveRef` mirrors "a turn is in progress", which includes a queued
      // run whose stream already closed — raw `isStreaming` is false there. The UI
      // already blocks this via `canSend`, but a programmatic caller (the chat
      // page's suggested-question chips) reaches this directly.
      if (!trimmed || !id || isTurnActiveRef.current) return

      if (!canChat) {
        setChatError(disabledReason ?? null)
        return
      }
      // Block on in-flight uploads: otherwise Enter bypasses the disabled button, the
      // text goes out and token-less attachments are silently dropped.
      if (pendingAttachments.some((a) => a.uploading)) {
        setChatError(t('agentDetail.attachmentUploading'))
        return
      }
      // Never send silently past a failed upload — the chip would vanish and the user
      // would believe the file was submitted.
      if (pendingAttachments.some((a) => a.error)) {
        setChatError(t('agentDetail.attachmentHasFailed'))
        return
      }

      // Close the gap before React commits `isStreaming`: a rapid second click or
      // programmatic call must not start another turn against the same chat.
      isTurnActiveRef.current = true

      const readyAttachments = pendingAttachments.filter((a) => a.token)
      const attachmentRefs = readyAttachments.map((a) => ({
        token: a.token as string,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      }))
      const sentAttachments: SentAttachment[] = readyAttachments.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        previewUrl: a.previewUrl,
      }))

      setChatInput('')
      setChatError(null)
      setStreamLogs([])
      setPendingAttachments([])
      setMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: trimmed,
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
        },
        // Empty agent bubble acting as the streaming placeholder.
        { role: 'agent', content: '' },
      ])
      setIsStreaming(true)
      // A new turn supersedes any run we were following: without this a stale
      // snapshot could overwrite the bubbles this turn is about to render, and a
      // handle retained from an abnormally-ended turn would make Stop cancel the
      // *previous* run. `canSend` already blocks while a queued run is pending, so
      // the superseded run here is one that has stopped reporting — cancel it
      // rather than leaving it to burn a concurrency slot unattended.
      const supersededRunId = activeRunIdRef.current
      transcriptSourceRef.current = { kind: 'idle' }
      setFollowedRunId(undefined)
      activeRunIdRef.current = undefined
      // This conversation now has content of its own, so it is no longer the blank
      // "just started" state that refreshHistory must protect.
      userStartedFreshRef.current = false
      if (supersededRunId) {
        api.post(`/runs/${supersededRunId}/cancel`, {}).catch(() => undefined)
      }

      abortControllerRef.current?.abort()
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      let watchdog: IdleWatchdog | null = null
      // Whether a terminal SSE event (done / queued) arrived. Read in `finally` to
      // decide if the run handle can be released — see the comment there.
      let reachedTerminalEvent = false

      try {
        const response = await fetch(`/api/agents/${id}/chat`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            stream: true,
            chatId,
            channel,
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
          }),
          signal: abortController.signal,
        })

        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ error: t('agentDetail.chatRequestFailed') }))
          if (response.status === 429) throw new Error(t('run.queueFull'))
          // The turn gate rejected us: the channel was disabled, or the Agent was
          // stopped/deactivated, since this page was opened. The profile is cached
          // for minutes, so without this the page would keep looking usable and
          // reject every further turn. Invalidating flips it to the explanatory
          // "unavailable" state on the next render.
          if (response.status === 404 && channel === 'chat_app' && id) {
            queryClient.invalidateQueries({ queryKey: ['agents', id, 'chat-app'] })
          }
          throw new Error(err.error || `HTTP ${response.status}`)
        }
        if (!response.body) throw new Error(t('agentDetail.chatNoResponseBody'))

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const accumulator = new SseEventAccumulator()
        let fullContent = ''
        let sawDoneEvent = false

        // If the server sends headers then goes silent, reader.read() would block
        // forever and the spinner would never stop. Abort after an idle gap so the
        // catch below can surface a "connection lost" message.
        watchdog = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS, () =>
          abortController.abort(new DOMException('stream idle timeout', 'TimeoutError')),
        )

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          watchdog.kick()

          // The accumulator keeps the `event:` type across chunks (TCP can split a
          // terminal `event: done` from its `data:` line) and resets it at the blank
          // line ending each SSE event.
          const events = accumulator.push(decoder.decode(value, { stream: true }))

          for (const { event: eventType, data: dataStr } of events) {
            try {
              const data = JSON.parse(dataStr)
              if (eventType === 'run_started') {
                // Arrives before execution begins so Stop has a run handle to cancel.
                //
                // Deliberately only the ref and the user-row stamp: calling
                // setCurrentRunId here would enable useChatMessages mid-stream, and
                // at this point the server transcript holds ONLY the user row (the
                // agent row is written at completion). Adopting that snapshot would
                // delete the streaming placeholder, after which every `update`
                // no-ops against a user-role last message and the reply never
                // renders. currentRunId is set on the terminal event instead.
                if (data.runId) {
                  activeRunIdRef.current = data.runId
                  setMessages((prev) => patchLastUserRunId(prev, data.runId))
                }
              } else if (eventType === 'update' && data.content) {
                fullContent += data.content
                setMessages((prev) => patchLastAgentMessage(prev, { content: fullContent }))
              } else if (eventType === 'log') {
                setStreamLogs((prev) => [...prev, data as StreamLogEntry])
              } else if (eventType === 'done') {
                sawDoneEvent = true
                reachedTerminalEvent = true
                if (data.chatId) setChatId(data.chatId)
                if (data.runId) {
                  setCurrentRunId(data.runId)
                  if (loadHistory) refetchChats()
                  setMessages((prev) => patchLastUserRunId(prev, data.runId))
                }
                if (data.reply && !fullContent) {
                  setMessages((prev) => patchLastAgentMessage(prev, { content: data.reply }))
                }
                refreshMemoryQueries()
              } else if (eventType === 'queued') {
                sawDoneEvent = true
                // Deliberately NOT a terminal event for run-handle purposes: the run
                // is still queued server-side and remains cancellable, so the handle
                // must survive `finally` for Stop / New conversation to reach it.
                if (data.runId) {
                  // The stream ends here; the reply can only arrive by polling.
                  transcriptSourceRef.current = { kind: 'awaitRun', runId: data.runId }
                  setFollowedRunId(data.runId)
                  activeRunIdRef.current = data.runId
                  setCurrentRunId(data.runId)
                  // A follow-up turn REUSES the same run row, so setCurrentRunId is a
                  // no-op and neither the query key nor the invalidate effect changes.
                  // Without an explicit invalidate the cached (completed) snapshot
                  // would keep isRunPending false, the poller would never start, and
                  // the reply would be unreachable short of a page reload.
                  if (id) {
                    queryClient.invalidateQueries({
                      queryKey: ['agents', id, 'chats', data.runId, 'messages'],
                    })
                  }
                  if (loadHistory) refetchChats()
                  setMessages((prev) =>
                    patchLastAgentMessage(prev, { content: t('run.queued'), runId: data.runId }),
                  )
                  setMessages((prev) => patchLastUserRunId(prev, data.runId))
                }
              } else if (eventType === 'error') {
                // The server reported the run as failed, so there is nothing left to
                // cancel. Counts as terminal, otherwise `finally` would retain a run
                // handle that no control can reach once Stop unmounts.
                reachedTerminalEvent = true
                // Point the run-scoped views (artifacts, "view log") at THIS run.
                // Only `done`/`queued` used to set it, so after a failed turn both
                // still showed the previous run's output — the most misleading
                // moment to be looking at the wrong logs.
                const failedRunId = activeRunIdRef.current
                if (failedRunId) {
                  setCurrentRunId(failedRunId)
                  setMessages((prev) => patchLastUserRunId(prev, failedRunId))
                }
                throw new Error(data.error || t('agentDetail.chatExecutionFailed'))
              }
            } catch (e) {
              // `heartbeat` carries empty data and lands here; ignore parse noise only.
              if (e instanceof SyntaxError) continue
              throw e
            }
          }
        }

        watchdog.clear()

        // Reader hit EOF. Without a terminal `done`/`queued` the connection dropped
        // mid-stream — surface it instead of leaving a truncated reply looking complete.
        if (interpretStreamEnd(sawDoneEvent) === 'incomplete') {
          throw new Error(t('agentDetail.chatConnectionLost'))
        }

        if (!fullContent) {
          setMessages((prev) => {
            const updated = [...prev]
            const last = updated.length - 1
            if (last >= 0 && updated[last].role === 'agent' && !updated[last].content) {
              return updated.slice(0, -1)
            }
            return updated
          })
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Distinguish a user-initiated abort (switch agent / new conversation) from
          // the idle-watchdog abort: the latter tags signal.reason with a TimeoutError
          // and must be shown as a dropped connection, not swallowed.
          const reason = abortController.signal.reason as { name?: string } | undefined
          if (reason?.name !== 'TimeoutError') return
        }
        const isTimeout =
          (abortController.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
        const errorMsg = isTimeout
          ? t('agentDetail.chatConnectionLost')
          : err instanceof Error
            ? err.message
            : t('agentDetail.chatFailed')
        const errorContent = t('agentDetail.chatErrorPrefix', { message: errorMsg })
        setMessages((prev) => {
          const updated = [...prev]
          const last = updated.length - 1
          if (last >= 0 && updated[last].role === 'agent' && !updated[last].content) {
            updated[last] = { ...updated[last], content: errorContent, failed: true }
          } else {
            updated.push({ role: 'agent', content: errorContent, failed: true })
          }
          return updated
        })
      } finally {
        watchdog?.clear()
        // Only tear down if THIS turn is still the current one. A superseded turn
        // (the user sent again, or reset) reaches its `finally` after the next turn
        // has already installed its own controller and streaming state — clearing
        // unconditionally would leave the new turn un-abortable and flip its
        // spinner off while it is still running.
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null
          // Keep the run handle when the turn ended abnormally (idle watchdog, mid-
          // stream disconnect): the server run is still executing and holding a
          // concurrency slot, so the user must retain the ability to cancel it.
          // Only a terminal event means there is nothing left to cancel.
          if (reachedTerminalEvent) activeRunIdRef.current = undefined
          setIsStreaming(false)
        }
      }
    },
    [
      canChat,
      chatId,
      chatInput,
      channel,
      disabledReason,
      id,
      loadHistory,
      pendingAttachments,
      queryClient,
      refetchChats,
      refreshMemoryQueries,
      t,
    ],
  )

  /**
   * Stop the in-flight turn.
   *
   * Aborting the fetch alone would only detach the client: the agent CLI keeps
   * running to completion, holds a concurrency slot and burns tokens. So the
   * server-side run is cancelled too, and the empty placeholder bubble is replaced
   * with a "stopped" note rather than left as a silently invisible entry.
   */
  const stopStreaming = useCallback(() => {
    // Cancels server-side too, and resets the transcript source there so no late
    // poll can replace the "stopped" note written below. The spinner is cleared
    // here rather than in the turn's `finally`, which now skips a superseded turn.
    abandonActiveRun()
    setIsStreaming(false)

    setMessages((prev) => {
      const updated = [...prev]
      const last = updated.length - 1
      if (last >= 0 && updated[last].role === 'agent' && !updated[last].content?.trim()) {
        updated[last] = { ...updated[last], content: t('agentDetail.chatStopped') }
      }
      return updated
    })
  }, [abandonActiveRun, t])

  /**
   * A turn is in progress — either streaming, or queued server-side and still
   * being polled.
   *
   * The queued case matters: the SSE stream ends at the `queued` event, so raw
   * `isStreaming` goes false while the run is very much alive. Reporting that as
   * "done" re-enabled the composer (letting a second turn orphan the first) and
   * hid the Stop button on a run that was still cancellable.
   */
  // Backed by state, not the ref: React does not re-render on ref mutation, so
  // deriving this from `transcriptSourceRef` left a window where the composer was
  // still enabled after a turn was queued. `followedRunId` is set in the same
  // commit as the other `queued` state updates, so the UI flips immediately.
  /**
   * A followed (queued) run counts as active until its OWN transcript proves it
   * settled. Deriving this from `isRunPending` alone left a full network-RTT hole:
   * the messages query is only enabled by the same commit that sets followedRunId,
   * so on the next render `chatHistoryData` is still undefined, `isRunPending` is
   * false, and the composer re-enabled on a live run — letting a second send cancel
   * the very turn the user was waiting for. Absence of data means "not yet known",
   * not "settled", so the pending assumption has to be the safe default.
   */
  // A queued FOLLOW-UP turn reuses the same run row, so the cached snapshot for
  // that id still reads `completed` from the previous turn — matching on id alone
  // declared the new turn settled and re-enabled the composer while it was live.
  // A refetch is in flight at exactly that moment (the queued branch invalidates
  // the key), so treat "still fetching" as "not yet known".
  const followedRunSettled =
    !!followedRunId &&
    chatHistoryData?.run?.id === followedRunId &&
    !isRunPending &&
    !chatHistoryFetching
  const isTurnActive = isStreaming || (!!followedRunId && !followedRunSettled)

  // Keep imperative guards aligned with the exact state exposed to the composer.
  // A completed restored run still has a followed id briefly; treating that id by
  // itself as active made the enabled Send button silently ignore clicks.
  useEffect(() => {
    isTurnActiveRef.current = isTurnActive
  }, [isTurnActive])

  const canSend =
    chatInput.trim().length > 0 &&
    !isTurnActive &&
    canChat &&
    !pendingAttachments.some((a) => a.uploading || a.error)

  return {
    messages,
    chatInput,
    setChatInput,
    pendingAttachments,
    addFiles,
    removeAttachment,
    isStreaming: isTurnActive,
    chatError,
    streamLogs,
    currentRunId,
    attachmentConfig,
    sendMessage,
    stopStreaming,
    startNewConversation,
    refreshHistory,
    canSend,
  }
}
