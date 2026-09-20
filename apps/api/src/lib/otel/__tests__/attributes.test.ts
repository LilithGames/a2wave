import { describe, expect, it } from 'vitest'
import {
  ATTR,
  CONTENT_MAX_LENGTH,
  classifyError,
  collectSecretValues,
  maskSecrets,
  toContentAttribute,
  truncate,
  usageAttributes,
} from '../attributes.js'

describe('truncate', () => {
  it('returns short values untouched', () => {
    expect(truncate('hello')).toBe('hello')
  })

  it('cuts at the limit and reports how much was dropped', () => {
    const out = truncate('x'.repeat(CONTENT_MAX_LENGTH + 10))
    expect(out.startsWith('x'.repeat(CONTENT_MAX_LENGTH))).toBe(true)
    expect(out.endsWith('…[truncated 10]')).toBe(true)
  })
})

describe('collectSecretValues', () => {
  it('collects provider credentials, agent env values and MCP env/header values', () => {
    const secrets = collectSecretValues({
      providerApiKey: 'provider-key-123',
      providerOauthToken: 'oauth-token-456',
      agentEnv: { DB_PASSWORD: 'hunter2-hunter2', SHORT: 'abc' },
      resolvedMcpServers: [
        {
          name: 'm',
          type: 'http',
          env: { MCP_TOKEN: 'mcp-env-secret' },
          headers: { Authorization: 'Bearer mcp-header-secret' },
        },
      ],
    })
    expect(secrets).toEqual(
      expect.arrayContaining([
        'provider-key-123',
        'oauth-token-456',
        'hunter2-hunter2',
        'mcp-env-secret',
        'Bearer mcp-header-secret',
      ]),
    )
    // Too short to mask safely: masking 'abc' would shred ordinary text.
    expect(secrets).not.toContain('abc')
  })

  it('tolerates a missing agent config', () => {
    expect(collectSecretValues(undefined)).toEqual([])
  })
})

describe('maskSecrets', () => {
  it('replaces known secret values', () => {
    expect(maskSecrets('key=provider-key-123 done', ['provider-key-123'])).toBe(
      'key=[REDACTED] done',
    )
  })

  it('masks the longest secret first so a contained shorter one cannot leave a tail', () => {
    expect(maskSecrets('Bearer abcdefgh-tail', ['abcdefgh', 'Bearer abcdefgh-tail'])).toBe(
      '[REDACTED]',
    )
  })

  it('masks credential-shaped tokens even when the value is unknown', () => {
    expect(maskSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', [])).toBe(
      'Authorization: Bearer [REDACTED]',
    )
    expect(maskSecrets('use sk-ant-api03-ABCDEFGHIJKLMNOP now', [])).toBe('use [REDACTED] now')
    expect(maskSecrets('a2ak_0123456789abcdef and ak_0123456789abcdef', [])).toBe(
      '[REDACTED] and [REDACTED]',
    )
  })
})

describe('toContentAttribute', () => {
  it('masks before truncating so a secret straddling the cut cannot leak its head', () => {
    const secret = 'S'.repeat(40)
    const text = `${'x'.repeat(CONTENT_MAX_LENGTH - 10)}${secret}`
    const out = toContentAttribute(text, [secret])
    expect(out).not.toContain('SSSS')
  })
})

describe('usageAttributes', () => {
  it('maps only the fields that were reported', () => {
    expect(usageAttributes({ inputTokens: 10, cacheReadTokens: 3 })).toEqual({
      [ATTR.USAGE_INPUT_TOKENS]: 10,
      [ATTR.USAGE_CACHE_READ_TOKENS]: 3,
    })
  })

  it('keeps a reported zero but never invents one', () => {
    expect(usageAttributes({ outputTokens: 0 })).toEqual({ [ATTR.USAGE_OUTPUT_TOKENS]: 0 })
    expect(usageAttributes(undefined)).toEqual({})
  })

  it('maps every TokenUsage field', () => {
    expect(
      usageAttributes({
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
      }),
    ).toEqual({
      [ATTR.USAGE_INPUT_TOKENS]: 1,
      [ATTR.USAGE_OUTPUT_TOKENS]: 2,
      [ATTR.USAGE_REASONING_TOKENS]: 3,
      [ATTR.USAGE_CACHE_READ_TOKENS]: 4,
      [ATTR.USAGE_CACHE_CREATION_TOKENS]: 5,
    })
  })
})

describe('classifyError', () => {
  const classifiers = {
    isPermanent: (e?: string) => e === 'perm',
    isHardQuota: (e?: string) => e === 'quota',
  }

  it('recognises timeouts first', () => {
    expect(classifyError('Execution timeout after 15 minutes', classifiers)).toBe('timeout')
  })

  it('defers to the retry classifiers', () => {
    expect(classifyError('quota', classifiers)).toBe('quota')
    expect(classifyError('perm', classifiers)).toBe('permanent')
  })

  it('falls back to the semconv catch-all', () => {
    expect(classifyError('something else', classifiers)).toBe('_OTHER')
    expect(classifyError(undefined)).toBe('_OTHER')
  })
})
