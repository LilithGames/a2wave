import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { upload: vi.fn(), post: vi.fn() } }))
vi.mock('@/lib/antd-static', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { message } from '@/lib/antd-static'
import { handleImportSuccess, reportImportWarnings } from '../import-agent-dialog'

const SENSITIVE_ENV_WARNING =
  'Sensitive environment variable values are not imported; re-enter them before use'

describe('reportImportWarnings', () => {
  /**
   * The import route clears masked credentials it cannot restore and reports that
   * through `warnings`. The dialog closes on success, so a warning that is never
   * surfaced is one the user never sees — they would discover the cleared secret
   * only when a run fails to authenticate against an empty credential.
   */
  it('raises one toast per server warning', () => {
    vi.mocked(message.warning).mockClear()

    reportImportWarnings([SENSITIVE_ENV_WARNING, 'Slack credentials are not imported'])

    expect(message.warning).toHaveBeenCalledTimes(2)
    expect(message.warning).toHaveBeenCalledWith(SENSITIVE_ENV_WARNING)
    expect(message.warning).toHaveBeenCalledWith('Slack credentials are not imported')
  })

  it('stays silent when the import reports nothing', () => {
    vi.mocked(message.warning).mockClear()

    reportImportWarnings([])
    reportImportWarnings(undefined)

    expect(message.warning).not.toHaveBeenCalled()
  })
})

describe('handleImportSuccess', () => {
  const result = {
    agent: { id: 'agt_1', name: 'Imported' },
    mcpServers: [],
    skills: [],
    warnings: [SENSITIVE_ENV_WARNING],
  }

  function run({ withOnSuccess = true } = {}) {
    const invalidate = vi.fn<(key: string) => void>()
    const onSuccess = vi.fn()
    const onClose = vi.fn()
    handleImportSuccess(result, {
      t: (key: string) => key,
      invalidate,
      onSuccess: withOnSuccess ? onSuccess : undefined,
      onClose,
    })
    return { invalidate, onSuccess, onClose }
  }

  /**
   * Both import paths funnel through here, so this is the single place that proves the
   * warning surface is actually wired — the callsites themselves cannot be driven from
   * a component test because the antd Modal footer does not render under jsdom.
   */
  it('reports warnings alongside the success toast', () => {
    run()

    expect(message.success).toHaveBeenCalled()
    expect(message.warning).toHaveBeenCalledWith(SENSITIVE_ENV_WARNING)
  })

  it('refreshes every list the import can touch, then hands off and closes', () => {
    const deps = run()

    expect(deps.invalidate.mock.calls.map(([k]) => k)).toEqual(['agents', 'skills', 'mcp-servers'])
    expect(deps.onSuccess).toHaveBeenCalledWith(result)
    expect(deps.onClose).toHaveBeenCalled()
  })

  it('closes even when the caller passes no onSuccess handler', () => {
    const deps = run({ withOnSuccess: false })

    expect(deps.onClose).toHaveBeenCalled()
  })
})
