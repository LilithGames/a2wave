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

describe('maskSecrets — secrets a2wave was never told about', () => {
  // Tool output is the content most likely to carry them: a `cat` of a config file, a CLI that
  // echoes its token, a key checked into the repository under review. Fixtures are assembled from
  // fragments so that no secret-shaped literal exists in this file.
  const join = (...parts: string[]) => parts.join('')
  const body = (n: number) => 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'.repeat(4).slice(0, n)

  it.each([
    ['GitLab personal token', join('glp', 'at-', body(20))],
    ['GitLab deploy token', join('gld', 't-', body(20))],
    ['GitHub classic token', join('gh', 'p_', body(36))],
    ['GitHub server token', join('gh', 's_', body(36))],
    ['GitHub fine-grained token', join('github', '_pat_', body(60))],
    ['AWS access key id', join('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['AWS temporary key id', join('AS', 'IA', 'IOSFODNN7EXAMPLE')],
    ['Slack token', join('xo', 'xb-', '1234567890-', body(16))],
    ['bare JWT', join('ey', 'J', body(14), '.', body(20), '.', body(24))],
  ])('masks a %s', (_label, token) => {
    const out = maskSecrets(`before ${token} after`, [])
    expect(out).toBe('before [REDACTED] after')
  })

  it('masks a whole PEM private key block, even one cut off before its END line', () => {
    const begin = join('-----BEGIN RSA PRIV', 'ATE KEY-----')
    const end = join('-----END RSA PRIV', 'ATE KEY-----')
    const whole = `head\n${begin}\nMIIEow${body(40)}\n${body(40)}\n${end}\ntail`
    expect(maskSecrets(whole, [])).toBe('head\n[REDACTED]\ntail')
    const cut = `head\n${begin}\nMIIEow${body(40)}`
    expect(maskSecrets(cut, [])).toBe('head\n[REDACTED]')
  })

  it('masks the value of a credential assignment and keeps the key, in the common config syntaxes', () => {
    const value = body(16)
    expect(maskSecrets(`password: ${value}`, [])).toBe('password: [REDACTED]')
    expect(maskSecrets(`DB_PASSWORD=${value}`, [])).toBe('DB_PASSWORD=[REDACTED]')
    expect(maskSecrets(`"client_secret": "${value}",`, [])).toBe('"client_secret": "[REDACTED]",')
    expect(maskSecrets(`api-key = '${value}'`, [])).toBe("api-key = '[REDACTED]'")
    expect(maskSecrets(`secret_key_base: "${value}"`, [])).toBe('secret_key_base: "[REDACTED]"')
  })

  it('leaves ordinary prose and code alone', () => {
    for (const text of [
      'the token count was 93257',
      'password: string',
      'const token = await getToken()',
      'secret: process.env.AUTH_SECRET',
      'passwords must be hashed with argon2',
      'glab mr view 74 --repo group/project',
      'AKIAXYZ is not long enough',
    ]) {
      expect(maskSecrets(text, [])).toBe(text)
    }
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
  it('reports input tokens INCLUDING cached ones, with the cache figures as details', () => {
    // The platform stores uncached input apart from cache reads/writes. Backends do not: the
    // OpenInference prompt count and cost model treat cache reads as a SUBSET of the input, so
    // exporting the uncached figure alone made Phoenix drop it from the trace total
    // (93,257 uncached + 1,145,856 cached showed up as 1,145,856).
    expect(usageAttributes({ inputTokens: 10, cacheReadTokens: 3 })).toEqual({
      [ATTR.USAGE_INPUT_TOKENS]: 13,
      [ATTR.USAGE_UNCACHED_INPUT_TOKENS]: 10,
      [ATTR.USAGE_CACHE_READ_TOKENS]: 3,
    })
    expect(usageAttributes({ inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4 })).toEqual({
      [ATTR.USAGE_INPUT_TOKENS]: 17,
      [ATTR.USAGE_UNCACHED_INPUT_TOKENS]: 10,
      [ATTR.USAGE_CACHE_READ_TOKENS]: 3,
      [ATTR.USAGE_CACHE_CREATION_TOKENS]: 4,
    })
  })

  it('leaves the input figure alone when no cache usage was reported', () => {
    expect(usageAttributes({ inputTokens: 10 })).toEqual({ [ATTR.USAGE_INPUT_TOKENS]: 10 })
    // Cache figures without an input figure: do not invent an input total.
    expect(usageAttributes({ cacheReadTokens: 3 })).toEqual({ [ATTR.USAGE_CACHE_READ_TOKENS]: 3 })
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
      [ATTR.USAGE_INPUT_TOKENS]: 10,
      [ATTR.USAGE_UNCACHED_INPUT_TOKENS]: 1,
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
