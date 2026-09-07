import { describe, expect, it } from 'vitest'
import { buildRetryMetadata } from '../run-retry-in-place.js'

/**
 * Retrying in place reuses the failed run's own row, so whatever the previous
 * attempt left in `executionMetadata` is the state the next attempt starts
 * from. Getting this wrong is silent: the run still executes, just not the way
 * anyone asked for.
 */
describe('buildRetryMetadata', () => {
  const previous = {
    runtimeAdminRequesterUserId: 'usr_old',
    oauthCallerId: 'caller_1',
    oauthEngineType: 'claude-code',
    liveChatId: 'sess_dead',
    resumeAttempts: 2,
    resumePending: { code: 'PROCESS_KILLED' },
    executionStarted: true,
    oauthPreviousChatId: 'sess_prev',
    oauthResetSession: true,
    nativeChatResetSession: true,
    jobRetryOf: 'run_origin',
    jobRetryAttempt: 3,
    queuedTurn: true,
    attachments: [{ token: 'att_old', name: 'a.txt', mimeType: 'text/plain' }],
    attachmentConsumerId: 'usr_old',
    gitTriggerOrigin: { provider: 'glab', event: 'opened', project: 'p', number: 1, queued: true },
  } as Record<string, unknown>

  it('drops the dead session so the retry cannot become a resume', () => {
    // resume-chat-id turns a surviving liveChatId + structured failure into a
    // session continuation: the Agent would be sent "carry on" instead of the
    // intent, and no user message would be recorded.
    // `resumePending` / `executionStarted` are written through
    // mergeExecutionMetadata and never declared on the column type, which is
    // precisely why an allowlist is the only safe way to drop them.
    const next = buildRetryMetadata(previous, { userId: 'usr_new' }) as Record<string, unknown>

    expect(next.liveChatId).toBeUndefined()
    expect(next.resumeAttempts).toBeUndefined()
    expect(next.resumePending).toBeUndefined()
    expect(next.executionStarted).toBeUndefined()
  })

  it('starts a fresh chain rather than inheriting the automatic retry budget', () => {
    const next = buildRetryMetadata(previous, { userId: 'usr_new' })

    expect(next.jobRetryOf).toBeUndefined()
    expect(next.jobRetryAttempt).toBeUndefined()
    expect(next.retryAttempt).toBe(1)
  })

  it('counts successive manual retries of the same row', () => {
    const next = buildRetryMetadata({ ...previous, retryAttempt: 2 }, { userId: 'usr_new' })

    expect(next.retryAttempt).toBe(3)
  })

  it('keeps the OAuth caller that owns this run', () => {
    // The field gates who may read and cancel the run; dropping it would widen
    // access, because an absent value is treated as legacy-and-allowed.
    const next = buildRetryMetadata(previous, { userId: 'usr_new' })

    expect(next.oauthCallerId).toBe('caller_1')
    expect(next.oauthEngineType).toBe('claude-code')
  })

  it('re-stamps the admin requester to whoever pressed retry', () => {
    const next = buildRetryMetadata(previous, { userId: 'usr_new' })

    expect(next.runtimeAdminRequesterUserId).toBe('usr_new')
  })

  it('replaces the previous attempt’s attachments rather than merging them', () => {
    const next = buildRetryMetadata(previous, {
      userId: 'usr_new',
      attachments: [{ token: 'att_new', name: 'b.txt', mimeType: 'text/plain' }],
      attachmentConsumerId: 'usr_new',
    })

    expect(next.attachments).toEqual([{ token: 'att_new', name: 'b.txt', mimeType: 'text/plain' }])
    expect(next.attachmentConsumerId).toBe('usr_new')
  })

  it('carries no attachments when the replay resolved none', () => {
    const next = buildRetryMetadata(previous, { userId: 'usr_new' })

    expect(next.attachments).toBeUndefined()
    expect(next.attachmentConsumerId).toBeUndefined()
  })

  it('marks the git-trigger origin as dispatched so staleness cannot cancel the retry', () => {
    // The staleness probe cancels a queued git-trigger run whose request was
    // merged meanwhile. Applied to a retry a human just asked for, it would
    // flip the row to `cancelled` and destroy the failure record.
    const next = buildRetryMetadata(previous, { userId: 'usr_new' })

    expect(next.gitTriggerOrigin).toMatchObject({ project: 'p', number: 1, queued: false })
  })

  it('marks the turn as queued only on the queued path', () => {
    expect(buildRetryMetadata(previous, { userId: 'usr_new' }).queuedTurn).toBeUndefined()
    expect(buildRetryMetadata(previous, { userId: 'usr_new', queuedTurn: true }).queuedTurn).toBe(
      true,
    )
  })

  it('carries durable channel context for the channels that need it after a queue wait', () => {
    const next = buildRetryMetadata(previous, {
      userId: 'usr_new',
      nativeChatContext: { receive_id: 'chat_1' },
    })

    expect(next.nativeChatContext).toEqual({ receive_id: 'chat_1' })
  })

  it('carries nothing it was not explicitly told to keep', () => {
    // An allowlist, not a denylist: a transient field added later must not
    // leak into the next attempt just because nobody remembered this function.
    const next = buildRetryMetadata(
      { ...previous, someFutureTransientFlag: true },
      {
        userId: 'usr_new',
      },
    )

    expect(next).not.toHaveProperty('someFutureTransientFlag')
  })
})
