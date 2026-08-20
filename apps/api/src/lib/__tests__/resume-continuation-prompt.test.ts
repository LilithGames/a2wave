import { describe, expect, it } from 'vitest'
import { buildResumeContinuationPrompt } from '../resume-continuation-prompt.js'

/**
 * Every supported CLI treats `--resume` / `exec resume` as "continue this
 * session with a new turn", and appends whatever prompt it is given. Passing
 * the original instruction again therefore asks the model to do the whole task
 * a second time — the exact replay this feature exists to prevent. The
 * continuation prompt is what makes resume mean resume.
 */
describe('buildResumeContinuationPrompt', () => {
  it('does not repeat the original instruction', () => {
    const original = 'Refactor the billing module and open a merge request'
    expect(buildResumeContinuationPrompt(original)).not.toContain(original)
  })

  it('tells the model the session was interrupted, not restarted', () => {
    const prompt = buildResumeContinuationPrompt('anything')
    expect(prompt.toLowerCase()).toContain('interrupted')
  })

  it('tells the model to check what already happened before acting', () => {
    // Without this the model may redo a step whose result never came back —
    // the narrow window between a tool completing and the process dying.
    const prompt = buildResumeContinuationPrompt('anything')
    expect(prompt).toMatch(/already|completed|repeat/i)
  })

  it('is stable, so a resumed turn is not itself a source of nondeterminism', () => {
    expect(buildResumeContinuationPrompt('a')).toBe(buildResumeContinuationPrompt('b'))
  })

  it('is non-empty, since every CLI requires a prompt argument', () => {
    expect(buildResumeContinuationPrompt('x').trim().length).toBeGreaterThan(0)
  })
})
