import { describe, expect, it } from 'vitest'
import { decideResume, MAX_RESUME_ATTEMPTS } from '../resume-decision.js'

/**
 * The decision that stands between "the run continues" and "the user's work is
 * silently re-done or lost". Every branch here is a deliberate refusal or a
 * deliberate continuation; nothing defaults.
 */
describe('decideResume', () => {
  const interrupted = {
    liveChatId: 'sess_a',
    resumeAttempts: 0,
    failureCode: 'SERVER_RESTART_DURING_EXEC' as const,
  }

  it('resumes a run interrupted by a restart that named its session', () => {
    expect(decideResume(interrupted)).toEqual({ resume: true, chatId: 'sess_a', attempt: 1 })
  })

  it('resumes a run whose owning instance stopped', () => {
    expect(decideResume({ ...interrupted, failureCode: 'INSTANCE_STOPPED_DURING_EXEC' })).toEqual({
      resume: true,
      chatId: 'sess_a',
      attempt: 1,
    })
  })

  it('refuses without a session id, since there is nothing to resume from', () => {
    // Starting fresh here would re-run a prompt whose side effects — commits,
    // messages, merge requests — may already have happened.
    expect(decideResume({ ...interrupted, liveChatId: null })).toEqual({
      resume: false,
      reason: 'no-session',
    })
  })

  it('refuses once the attempt budget is spent', () => {
    // Without a ceiling, a crash that reproduces on resume becomes an infinite
    // crash-resume loop that is strictly worse than failing fast.
    expect(decideResume({ ...interrupted, resumeAttempts: MAX_RESUME_ATTEMPTS })).toEqual({
      resume: false,
      reason: 'attempts-exhausted',
    })
  })

  it('counts each attempt so the budget actually decrements', () => {
    expect(decideResume({ ...interrupted, resumeAttempts: 1 })).toMatchObject({ attempt: 2 })
  })

  it('refuses a failure that was not an interruption', () => {
    // A run that failed on its own merits must not be resurrected by recovery;
    // only interruptions are safe to continue.
    expect(decideResume({ ...interrupted, failureCode: 'DANGLING_RUN_ON_STARTUP' })).toEqual({
      resume: false,
      reason: 'not-interrupted',
    })
  })

  it('refuses when the agent was deleted, whatever the other signals say', () => {
    expect(decideResume({ ...interrupted, agentMissing: true })).toEqual({
      resume: false,
      reason: 'agent-missing',
    })
  })

  it('treats a negative or corrupt attempt count as spent rather than infinite', () => {
    expect(decideResume({ ...interrupted, resumeAttempts: -1 })).toEqual({
      resume: false,
      reason: 'attempts-exhausted',
    })
    expect(decideResume({ ...interrupted, resumeAttempts: Number.NaN })).toEqual({
      resume: false,
      reason: 'attempts-exhausted',
    })
  })
})
