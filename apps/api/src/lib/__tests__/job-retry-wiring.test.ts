/**
 * The failure path of runWithLifecycle must hand off to the job-retry
 * scheduler — and must do so ONLY on failure, never on success.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(import.meta.dirname, '../run-launcher.ts'), 'utf8')

describe('run-launcher job-retry wiring', () => {
  it('imports the retry hook', () => {
    expect(src).toMatch(/from '\.\/job-retry-hook\.js'/)
  })

  it('invokes the hook after finishRunError on the engine-failure path', () => {
    const engineFail = src.slice(src.indexOf('const engineError ='))
    expect(engineFail).toMatch(/runJobRetryHook\(/)
  })

  it('invokes the hook on the thrown-error path', () => {
    const thrown = src.slice(src.indexOf('} catch (err) {'))
    expect(thrown).toMatch(/runJobRetryHook\(/)
  })

  it('does not invoke the hook on the success path', () => {
    const start = src.indexOf('if (result.success) {')
    const end = src.indexOf('const engineError =')
    expect(src.slice(start, end)).not.toMatch(/runJobRetryHook\(/)
  })
})
