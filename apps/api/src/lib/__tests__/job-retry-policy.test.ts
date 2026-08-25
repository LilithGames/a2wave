import { describe, expect, it } from 'vitest'
import {
  clampJobRetries,
  JOB_RETRIES_MAX,
  JOB_RETRIES_MIN,
  nextJobRetryAttempt,
  shouldRetryJob,
} from '../job-retry-policy.js'

describe('clampJobRetries', () => {
  it('clamps to the 0..3 range', () => {
    expect(JOB_RETRIES_MIN).toBe(0)
    expect(JOB_RETRIES_MAX).toBe(3)
    expect(clampJobRetries(-5)).toBe(0)
    expect(clampJobRetries(0)).toBe(0)
    expect(clampJobRetries(2)).toBe(2)
    expect(clampJobRetries(3)).toBe(3)
    expect(clampJobRetries(99)).toBe(3)
  })

  it('floors fractional input', () => {
    expect(clampJobRetries(2.9)).toBe(2)
  })
})

describe('shouldRetryJob', () => {
  const base = {
    status: 'failed' as const,
    error: 'connection reset',
    maxJobRetries: 2,
    attempt: 0,
  }

  it('is disabled by default (0 retries means never)', () => {
    expect(shouldRetryJob({ ...base, maxJobRetries: 0 }).retry).toBe(false)
  })

  it('retries a transient failure while budget remains', () => {
    expect(shouldRetryJob(base).retry).toBe(true)
  })

  it('stops once the budget is spent', () => {
    expect(shouldRetryJob({ ...base, attempt: 2 }).retry).toBe(false)
    expect(shouldRetryJob({ ...base, attempt: 3 }).retry).toBe(false)
  })

  it('never retries a cancelled run', () => {
    const decision = shouldRetryJob({ ...base, status: 'cancelled' })
    expect(decision.retry).toBe(false)
    expect(decision.reason).toBe('not_failed')
  })

  it('never retries a completed run', () => {
    expect(shouldRetryJob({ ...base, status: 'completed' }).retry).toBe(false)
  })

  it.each([
    ['unauthorized (401)', 'Request failed with status 401'],
    ['forbidden', 'forbidden: token rejected'],
    ['content policy', 'blocked by content policy'],
    ['worktree', 'worktree is dirty'],
  ])('skips permanent error: %s', (_label, error) => {
    const decision = shouldRetryJob({ ...base, error })
    expect(decision.retry).toBe(false)
    expect(decision.reason).toBe('permanent_error')
  })

  it.each([
    ['session limit', 'You hit your session limit'],
    ['daily limit', 'daily limit reached'],
    ['quota', 'quota exceeded for this account'],
  ])('skips hard quota error: %s', (_label, error) => {
    const decision = shouldRetryJob({ ...base, error })
    expect(decision.retry).toBe(false)
    expect(decision.reason).toBe('permanent_error')
  })

  it('still retries a soft rate limit, which a fresh job may clear', () => {
    expect(shouldRetryJob({ ...base, error: 'rate limit exceeded (429)' }).retry).toBe(true)
  })

  it('retries when the error is unknown', () => {
    expect(shouldRetryJob({ ...base, error: undefined }).retry).toBe(true)
  })
})

describe('nextJobRetryAttempt', () => {
  it('starts an original run at attempt 1', () => {
    expect(nextJobRetryAttempt(undefined)).toBe(1)
    expect(nextJobRetryAttempt(0)).toBe(1)
  })

  it('increments an existing chain', () => {
    expect(nextJobRetryAttempt(1)).toBe(2)
    expect(nextJobRetryAttempt(2)).toBe(3)
  })
})
