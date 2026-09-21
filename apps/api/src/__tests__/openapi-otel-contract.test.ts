import { describe, expect, it } from 'vitest'
import { openApiSpec } from '../openapi.js'

interface JsonSchema {
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, JsonSchema & { enum?: string[]; pattern?: string }>
}

describe('OpenAPI OpenTelemetry test-connection contract', () => {
  const operation = openApiSpec.paths['/settings/otel/test']?.post

  it('documents an optional draft body that cannot carry enabled or the ciphertext', () => {
    expect(operation?.security).toEqual([{ sessionCookie: [] }, { userSession: [] }])
    const body = operation?.requestBody as {
      required?: boolean
      content: { 'application/json': { schema: JsonSchema } }
    }
    expect(body.required).toBe(false)
    expect(Object.keys(body.content['application/json'].schema.properties ?? {})).toEqual([
      'endpoint',
      'serviceName',
      'resourceAttributes',
      'headers',
    ])
  })

  it('documents the verdict: always 200, every failure reason, testedUrl and traceId', () => {
    const responses = operation?.responses as Record<
      string,
      { content?: { 'application/json': { schema: JsonSchema } } }
    >
    expect(Object.keys(responses)).toEqual(['200', '401', '403'])
    const data = responses['200'].content?.['application/json'].schema.properties?.data
    expect(data?.required).toEqual(['ok'])
    expect(data?.properties?.reason.enum).toEqual([
      'OTEL_NOT_CONFIGURED',
      'INVALID_CONFIG',
      'LOOPBACK_REFUSED',
      'EXPORT_FAILED',
      'TIMEOUT',
    ])
    expect(data?.properties).toHaveProperty('testedUrl')
    expect(data?.properties?.traceId.pattern).toBe('^[0-9a-f]{32}$')
  })
})
