import { slugify } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { idSuffix } from '../id-suffix'

/**
 * The agent detail page previews the temp workspace directory. It must match the
 * directory the API actually creates in `resolveAgentWorkDir`
 * (apps/api/src/lib/agent-helpers.ts): `<workspacePath>/<slugify(name)>-<idSuffix>`.
 */
function previewWorkDir(workspacePath: string, name: string, id: string): string {
  return `${workspacePath}/${slugify(name)}-${idSuffix(id)}`
}

describe('temp workspace path preview', () => {
  it('matches the real directory for an ASCII agent name', () => {
    expect(previewWorkDir('/tmp/a2wave-sandbox', 'Code Review', 'agt_ak031ipiaH4y2B9Y')).toBe(
      '/tmp/a2wave-sandbox/code-review-ak031ipiaH4y2B9Y',
    )
  })

  it('keeps CJK in the slug instead of dropping it', () => {
    expect(previewWorkDir('/tmp/a2wave-sandbox', 'MR 自动评审', 'agt_ak031ipiaH4y2B9Y')).toBe(
      '/tmp/a2wave-sandbox/mr-自动评审-ak031ipiaH4y2B9Y',
    )
  })

  it('falls back to a hash slug rather than a bare suffix for symbol-only names', () => {
    const path = previewWorkDir('/tmp/a2wave-sandbox', '!!!', 'agt_ak031ipiaH4y2B9Y')
    expect(path).toMatch(/^\/tmp\/a2wave-sandbox\/id-[0-9a-f]+-ak031ipiaH4y2B9Y$/)
  })
})
