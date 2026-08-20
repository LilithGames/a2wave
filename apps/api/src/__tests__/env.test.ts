import { describe, expect, it } from 'vitest'
import { envSchema, formatEnvIssues } from '../env.js'

const validDevEnv = {
  NODE_ENV: 'development',
  AUTH_SECRET: 'a-local-dev-secret-from-dot-env-file',
}

const validProductionEnv = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'a-very-secure-production-secret-key',
  CURSOR_API_KEY: 'sk-prod-api-key-value',
}

describe('envSchema', () => {
  describe('development environment', () => {
    it('accepts values with an explicit AUTH_SECRET', async () => {
      const result = envSchema.safeParse(validDevEnv)
      expect(result.success).toBe(true)
    })

    // AUTH_SECRET is mandatory outside NODE_ENV=test: a missing .env (or an
    // unfilled AUTH_SECRET= line) must fail startup instead of silently running
    // on a well-known default secret.
    it('rejects a missing AUTH_SECRET', async () => {
      const result = envSchema.safeParse({ NODE_ENV: 'development' })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join('\n')
        expect(messages).toContain('AUTH_SECRET')
        // The error must be actionable: point at the .env setup step.
        expect(messages).toMatch(/\.env/)
      }
    })

    it('rejects a whitespace-only AUTH_SECRET (as useless as a missing one)', async () => {
      const result = envSchema.safeParse({ NODE_ENV: 'development', AUTH_SECRET: '   ' })
      expect(result.success).toBe(false)
    })

    it('rejects the historical default secret in development too', async () => {
      // Accepting it would re-arm the no-token auth bypass in auth-middleware.
      const result = envSchema.safeParse({
        NODE_ENV: 'development',
        AUTH_SECRET: 'dev-secret-change-me',
      })
      expect(result.success).toBe(false)
    })

    it('accepts empty CURSOR_API_KEY', async () => {
      const result = envSchema.safeParse({
        ...validDevEnv,
        CURSOR_API_KEY: '',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('test environment', () => {
    it('accepts default values and injects a usable AUTH_SECRET', async () => {
      const result = envSchema.safeParse({ NODE_ENV: 'test' })
      expect(result.success).toBe(true)
      if (result.success) {
        // Downstream JWT sign/verify must not silently run on undefined.
        expect(typeof result.data.AUTH_SECRET).toBe('string')
        expect(result.data.AUTH_SECRET.length).toBeGreaterThan(0)
      }
    })

    it('defaults the Provider trust allowlist to empty and preserves an explicit host list', async () => {
      expect(envSchema.parse({ NODE_ENV: 'test' }).TRUSTED_PROVIDER_HOSTS).toBe('')
      expect(
        envSchema.parse({
          NODE_ENV: 'test',
          TRUSTED_PROVIDER_HOSTS: 'proxy.internal.example.com,trae.internal.example.com',
        }).TRUSTED_PROVIDER_HOSTS,
      ).toBe('proxy.internal.example.com,trae.internal.example.com')
    })

    it('defaults outbound route protection on and accepts exact MCP/A2A hostname allowlists', () => {
      const defaults = envSchema.parse({ NODE_ENV: 'test' })
      expect(defaults.ALLOW_PRIVATE_ROUTE_TARGETS).toBe(true)
      expect(defaults.TRUSTED_MCP_HOSTS).toBe('')
      expect(defaults.TRUSTED_A2A_ROUTE_HOSTS).toBe('')

      expect(
        envSchema.safeParse({
          NODE_ENV: 'test',
          ALLOW_PRIVATE_ROUTE_TARGETS: 'false',
          TRUSTED_MCP_HOSTS: 'mcp.internal.example,tools.corp.example',
          TRUSTED_A2A_ROUTE_HOSTS: 'agents.internal.example',
        }).success,
      ).toBe(true)
      expect(
        envSchema.parse({ NODE_ENV: 'test', ALLOW_PRIVATE_ROUTE_TARGETS: 'false' })
          .ALLOW_PRIVATE_ROUTE_TARGETS,
      ).toBe(false)
      for (const invalid of ['https://mcp.example', '*.example.com', '10.0.0.5', 'mcp.example/x']) {
        expect(envSchema.safeParse({ NODE_ENV: 'test', TRUSTED_MCP_HOSTS: invalid }).success).toBe(
          false,
        )
      }
    })

    it('accepts only exact DNS hostnames in the remote import allowlist', async () => {
      expect(envSchema.parse({ NODE_ENV: 'test' }).TRUSTED_IMPORT_HOSTS).toBe('')
      expect(
        envSchema.safeParse({
          NODE_ENV: 'test',
          TRUSTED_IMPORT_HOSTS: 'exports.internal.example,backup.corp.example',
        }).success,
      ).toBe(true)

      for (const invalid of [
        'https://exports.example',
        '*.example.com',
        '10.0.0.5',
        'exports.example/path',
      ]) {
        expect(
          envSchema.safeParse({ NODE_ENV: 'test', TRUSTED_IMPORT_HOSTS: invalid }).success,
        ).toBe(false)
      }
    })

    it('requires every SCM workspace allowlist entry to be an absolute path', async () => {
      expect(
        envSchema.safeParse({
          NODE_ENV: 'test',
          SCM_WORKSPACES_ALLOWED_ROOTS: '/srv/worktrees,relative/path',
        }).success,
      ).toBe(false)
      expect(
        envSchema.safeParse({
          NODE_ENV: 'test',
          SCM_WORKSPACES_ALLOWED_ROOTS: '/srv/worktrees,/mnt/fast-worktrees',
        }).success,
      ).toBe(true)
    })

    it('requires SCM_STORAGE_ROOT to be an absolute path', async () => {
      expect(
        envSchema.safeParse({ NODE_ENV: 'test', SCM_STORAGE_ROOT: 'relative/path' }).success,
      ).toBe(false)
      expect(
        envSchema.safeParse({ NODE_ENV: 'test', SCM_STORAGE_ROOT: '/srv/a2wave-scm' }).success,
      ).toBe(true)
    })
  })

  describe('production environment', () => {
    it('rejects default AUTH_SECRET', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SECRET: 'dev-secret-change-me',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message)
        expect(messages).toContainEqual(expect.stringContaining('AUTH_SECRET'))
      }
    })

    it('rejects AUTH_SECRET shorter than 16 characters', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SECRET: 'short',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message)
        expect(messages).toContainEqual(expect.stringContaining('AUTH_SECRET'))
      }
    })

    it('accepts empty CURSOR_API_KEY (agent-level key can be provided in UI)', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        CURSOR_API_KEY: '',
      })
      expect(result.success).toBe(true)
    })

    it('accepts empty CURSOR_API_KEY when ANTHROPIC_API_KEY is provided', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        CURSOR_API_KEY: '',
        ANTHROPIC_API_KEY: 'sk-anthropic-prod-key',
      })
      expect(result.success).toBe(true)
    })

    it('accepts valid production configuration', async () => {
      const result = envSchema.safeParse(validProductionEnv)
      expect(result.success).toBe(true)
    })

    it('defaults auth session ttl to a working week', async () => {
      const result = envSchema.parse(validProductionEnv)
      expect(result.AUTH_SESSION_TTL_DAYS).toBe(7)
    })

    it('accepts configurable auth session ttl days', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SESSION_TTL_DAYS: '7',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.AUTH_SESSION_TTL_DAYS).toBe(7)
      }
    })

    it('rejects invalid auth session ttl days', async () => {
      const tooSmall = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SESSION_TTL_DAYS: '0',
      })
      const tooLarge = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SESSION_TTL_DAYS: '366',
      })
      const empty = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SESSION_TTL_DAYS: '',
      })
      const fractional = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_SESSION_TTL_DAYS: '1.5',
      })

      expect(tooSmall.success).toBe(false)
      expect(tooLarge.success).toBe(false)
      expect(empty.success).toBe(false)
      expect(fractional.success).toBe(false)
    })

    it('rejects obviously invalid trusted proxy addresses', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        TRUSTED_PROXY: 'true',
        TRUSTED_PROXY_ADDRESSES: '10.0.0.1:443',
      })

      expect(result.success).toBe(false)
    })

    it('accepts comma-separated trusted proxy IPs and CIDRs', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        TRUSTED_PROXY: 'true',
        TRUSTED_PROXY_ADDRESSES: '10.0.0.1, 192.168.0.0/16, 2001:db8::1',
      })

      expect(result.success).toBe(true)
    })

    // Regression: docker-compose `${AUTH_COOKIE_SECURE:-}` substitution can
    // produce '' when the host hasn't set the var. Previously '' was silently
    // accepted and fell back to NODE_ENV → unintended Secure=true on HTTP
    // ingress, breaking cookies & looping login. Now it must fail-loud.
    it('rejects AUTH_COOKIE_SECURE="" (fail-loud instead of silent fallback)', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_COOKIE_SECURE: '',
      })
      expect(result.success).toBe(false)
    })

    it('accepts explicit AUTH_COOKIE_SECURE=false on HTTP-ingress deployments', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        AUTH_COOKIE_SECURE: 'false',
      })
      expect(result.success).toBe(true)
    })

    it('accepts unset AUTH_COOKIE_SECURE (falls back to NODE_ENV inference)', async () => {
      const result = envSchema.safeParse(validProductionEnv)
      expect(result.success).toBe(true)
    })

    // Regression: docker-compose `${VAR:-}` and .env.example `KEY=` yield '' for
    // numeric vars. z.coerce.number() reads '' as 0 (Number('') === 0), so .default()
    // would not apply — numberEnv normalizes '' to undefined so the default holds.
    it('numeric env vars fall back to their default on empty string (numberEnv)', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        PORT: '',
        CURSOR_AGENT_TIMEOUT_MINUTES: '',
        OPENCODE_TIMEOUT_MINUTES: '',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.PORT).toBe(3502)
        expect(result.data.CURSOR_AGENT_TIMEOUT_MINUTES).toBe(10)
        expect(result.data.OPENCODE_TIMEOUT_MINUTES).toBe(10)
      }
    })

    it('numeric env vars still parse explicit values (numberEnv)', async () => {
      const result = envSchema.safeParse({
        ...validProductionEnv,
        PORT: '8080',
        OPENCODE_TIMEOUT_MINUTES: '25',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.PORT).toBe(8080)
        expect(result.data.OPENCODE_TIMEOUT_MINUTES).toBe(25)
      }
    })
  })

  // Regression: .env.example ships `AUTH_SECRET=` / `CORS_ORIGIN=` (empty) and its
  // header says "cp .env.example .env". An empty string is not undefined, so an
  // unfilled `AUTH_SECRET=` previously signed JWTs with '' and `CORS_ORIGIN=`
  // rejected every origin. Empty now means "unset": AUTH_SECRET fails loudly
  // (it is mandatory outside test), operational vars fall back to their default.
  describe('empty-string traps from .env.example', () => {
    it('AUTH_SECRET="" fails like a missing secret instead of signing with an empty one', async () => {
      const result = envSchema.safeParse({ ...validDevEnv, AUTH_SECRET: '' })
      expect(result.success).toBe(false)
    })

    it('AUTH_SECRET="" in production also fails', async () => {
      const result = envSchema.safeParse({ ...validProductionEnv, AUTH_SECRET: '' })
      expect(result.success).toBe(false)
    })

    it('CORS_ORIGIN="" falls back to the default origin', async () => {
      const result = envSchema.safeParse({ ...validDevEnv, CORS_ORIGIN: '' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.CORS_ORIGIN).toBe('http://localhost:3501')
      }
    })
  })
})

// PUBLIC_URL is the instance's externally reachable origin. It is the
// prerequisite for URL-form gateway JWT issuers: without it the instance cannot
// state its own `iss` or a `jwks_uri` that a standards-compliant gateway can
// fetch. Optional by design — leaving it unset keeps the opaque kebab issuer
// path working exactly as before.
describe('PUBLIC_URL', () => {
  it('defaults to empty when unset (URL-issuer mode simply unavailable)', async () => {
    const result = envSchema.safeParse(validDevEnv)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('')
  })

  it('treats an empty string as unset rather than as an invalid URL', async () => {
    // docker-compose `${PUBLIC_URL:-}` passthrough yields '' on an unset host var;
    // that must behave like "not configured", not fail startup.
    const result = envSchema.safeParse({ ...validDevEnv, PUBLIC_URL: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('')
  })

  it('accepts an https origin', async () => {
    const result = envSchema.safeParse({
      ...validDevEnv,
      PUBLIC_URL: 'https://a2wave.example.com',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('https://a2wave.example.com')
  })

  it('accepts an http origin for local/intranet deployments', async () => {
    const result = envSchema.safeParse({ ...validDevEnv, PUBLIC_URL: 'http://localhost:3502' })
    expect(result.success).toBe(true)
  })

  it('strips a trailing slash so derived URLs never double up separators', async () => {
    // jwks_uri is built as `${PUBLIC_URL}/.well-known/jwks.json`; a stored
    // trailing slash would emit `...com//.well-known/...` and break strict
    // gateway issuer matching.
    const result = envSchema.safeParse({
      ...validDevEnv,
      PUBLIC_URL: 'https://a2wave.example.com/',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('https://a2wave.example.com')
  })

  // `enable` compares the issuer to PUBLIC_URL byte-for-byte, so a
  // non-canonical host would reject the matching lowercase issuer with a 400.
  it('lowercases the host so issuer comparison is not case-sensitive', async () => {
    const result = envSchema.safeParse({
      ...validDevEnv,
      PUBLIC_URL: 'https://A2Wave.Example.COM',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('https://a2wave.example.com')
  })

  it('drops a default port so it matches the canonical origin form', async () => {
    const result = envSchema.safeParse({
      ...validDevEnv,
      PUBLIC_URL: 'https://a2wave.example.com:443',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('https://a2wave.example.com')
  })

  it('keeps a non-default port', async () => {
    const result = envSchema.safeParse({
      ...validDevEnv,
      PUBLIC_URL: 'https://a2wave.example.com:8443',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PUBLIC_URL).toBe('https://a2wave.example.com:8443')
  })

  it('rejects a non-URL string', async () => {
    const result = envSchema.safeParse({ ...validDevEnv, PUBLIC_URL: 'a2wave.example.com' })
    expect(result.success).toBe(false)
  })

  it('rejects a non-http(s) scheme', async () => {
    const result = envSchema.safeParse({ ...validDevEnv, PUBLIC_URL: 'ftp://a2wave.example.com' })
    expect(result.success).toBe(false)
  })

  it('rejects a URL carrying a path, so it stays a pure origin', async () => {
    // Anything beyond the origin makes `${PUBLIC_URL}/.well-known/...` land on a
    // path no gateway would discover.
    const result = envSchema.safeParse({
      ...validDevEnv,
      PUBLIC_URL: 'https://a2wave.example.com/sub/path',
    })
    expect(result.success).toBe(false)
  })
})

describe('formatEnvIssues', () => {
  it('renders one actionable line per issue instead of a raw ZodError dump', async () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      AUTH_SECRET: 'short',
      AUTH_SESSION_TTL_DAYS: '0',
    })
    expect(result.success).toBe(false)
    if (result.success) return

    const lines = formatEnvIssues(result.error)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) {
      // Each line names the offending variable and states the problem.
      expect(line).toMatch(/^[A-Z0-9_.]+: .+/)
    }
    expect(lines.join('\n')).toContain('AUTH_SECRET')
    expect(lines.join('\n')).toContain('AUTH_SESSION_TTL_DAYS')
  })
})
