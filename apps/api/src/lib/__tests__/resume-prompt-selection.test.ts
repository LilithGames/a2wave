/**
 * Which prompt a resumed run sends — the difference between continuing the
 * task and doing it twice.
 *
 * Verified against the real `codex exec resume` CLI, killing a task with
 * SIGKILL after its first side effect had committed:
 *
 *   resending the original prompt -> log.txt = STEP1, STEP1, STEP2, STEP3
 *   sending the continuation turn -> log.txt = STEP1, STEP2, STEP3
 *
 * The duplicate is the side-effect replay this feature exists to prevent, and
 * it is invisible to any test that only checks a session id was passed. These
 * cases pin the selection so that stays true.
 */
import { describe, expect, it } from 'vitest'
import { buildResumeContinuationPrompt } from '../resume-continuation-prompt.js'

/** Mirrors the choice made in execute-chat-run's resolveQueuedChatId path. */
function selectPrompt(originalPrompt: string, isResume: boolean): string {
  return isResume ? buildResumeContinuationPrompt(originalPrompt) : originalPrompt
}

const ORIGINAL = 'Append STEP1, then STEP2, then STEP3 to log.txt, one command each'

describe('prompt selection for a resumed run', () => {
  it('sends the original prompt on a normal run', () => {
    expect(selectPrompt(ORIGINAL, false)).toBe(ORIGINAL)
  })

  it('never re-sends the original instruction on a resume', () => {
    // The CLI appends whatever it is handed to the resumed session, so the
    // original text arriving again reads as "do this task", not "carry on".
    expect(selectPrompt(ORIGINAL, true)).not.toContain('STEP1')
    expect(selectPrompt(ORIGINAL, true)).not.toBe(ORIGINAL)
  })

  it('sends a non-empty turn, since every CLI requires a prompt argument', () => {
    expect(selectPrompt(ORIGINAL, true).trim().length).toBeGreaterThan(0)
  })

  it('sends the same continuation whatever the original task was', () => {
    // The session already carries the task; the continuation only has to say
    // why the model is being asked again. Interpolating any of the original
    // text back in is what reintroduces the replay.
    expect(selectPrompt('deploy to production', true)).toBe(selectPrompt('write a haiku', true))
  })
})
