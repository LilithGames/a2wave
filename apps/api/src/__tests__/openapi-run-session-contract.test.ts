import { describe, expect, it } from 'vitest'
import { openApiSpec } from '../openapi.js'

describe('OpenAPI Run session contract', () => {
  it('documents the grouped list and complete conversation detail endpoints', () => {
    expect(openApiSpec.paths['/runs/sessions']?.get?.security).toEqual([{ sessionCookie: [] }])
    expect(openApiSpec.paths['/runs/{runId}/session']?.get?.security).toEqual([
      { sessionCookie: [] },
    ])
    expect(openApiSpec.paths['/runs/sessions']?.get?.responses).toHaveProperty('200')
    expect(openApiSpec.paths['/runs/{runId}/session']?.get?.responses).toHaveProperty('404')
  })

  it('exposes aggregate status and per-Run transcript fields', () => {
    const summary = openApiSpec.components?.schemas?.RunSessionSummary as {
      required?: string[]
    }
    const detail = openApiSpec.components?.schemas?.RunSessionDetail as {
      required?: string[]
    }
    expect(summary.required).toEqual(
      expect.arrayContaining([
        'id',
        'conversationId',
        'latestRun',
        'status',
        'runCount',
        'turnCount',
        'failedRunIds',
        'activeRunId',
      ]),
    )
    expect(detail.required).toEqual(['summary', 'runs'])
  })

  it('does not expose raw steps or private attachment fields', () => {
    const sessionRun = openApiSpec.components?.schemas?.RunSessionRun as {
      required?: string[]
      properties?: Record<string, unknown>
    }
    const sessionMessage = openApiSpec.components?.schemas?.RunSessionMessage as {
      properties?: {
        attachments?: {
          items?: { additionalProperties?: boolean; properties?: Record<string, unknown> }
        }
      }
    }

    expect(sessionRun.required).toEqual(['run', 'messages', 'hasFullLog'])
    expect(sessionRun.properties).not.toHaveProperty('steps')
    expect(sessionMessage.properties?.attachments?.items?.additionalProperties).toBe(false)
    expect(Object.keys(sessionMessage.properties?.attachments?.items?.properties ?? {})).toEqual([
      'token',
      'name',
      'mimeType',
      'size',
    ])
  })
})
