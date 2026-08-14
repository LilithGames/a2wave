import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockExistsSync = vi.fn<(p: string) => boolean>()
const mockMkdirSync = vi.fn()
const mockRmSync = vi.fn()
const mockChmodSync = vi.fn()
const mockReaddirSync = vi.fn<(p: string) => string[]>()
const mockReadFileSync = vi.fn<(p: string, enc?: unknown) => string>()
const mockWriteFileSync = vi.fn<(p: string, content: string, opts?: unknown) => void>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => mockExistsSync(p),
  mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
  rmSync: (...a: unknown[]) => mockRmSync(...a),
  chmodSync: (...a: unknown[]) => mockChmodSync(...a),
  readdirSync: (p: string) => mockReaddirSync(p),
  readFileSync: (p: string, e?: unknown) => mockReadFileSync(p, e),
  writeFileSync: (p: string, c: string, o?: unknown) => mockWriteFileSync(p, c, o),
}))

const mockExecSync = vi.fn<(cmd: string, opts?: unknown) => string>()
vi.mock('node:child_process', () => ({
  execSync: (cmd: string, opts?: unknown) => mockExecSync(cmd, opts),
}))

const mockCreateServer = vi.fn()
vi.mock('node:net', () => ({
  createServer: (...a: unknown[]) => mockCreateServer(...a),
}))

const mockAskQuestion = vi.fn<(q: string) => Promise<string>>()
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: (q: string) => mockAskQuestion(q),
    close: () => {},
  }),
}))

function mockIsTTY(tty: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
}

const mockLoadConfig = vi.fn()
const mockSaveConfig = vi.fn()
vi.mock('../../config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (c: unknown) => mockSaveConfig(c),
}))

// The admin password is read with echo suppressed (shared with `a2wave login`),
// so it goes through readSecret rather than the readline mock above.
const mockReadSecret = vi.fn<(prompt: string) => Promise<string>>()
vi.mock('../../lib/prompt.js', () => ({
  readSecret: (prompt: string) => mockReadSecret(prompt),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { setupCommand, DEFAULT_IMAGE } = await import('../setup.js')
const { CliError } = await import('../../errors.js')
const { getVersion } = await import('../../version.js')
function mockPortFree(free: boolean): void {
  mockCreateServer.mockReturnValue({
    once(event: string, cb: (err?: Error) => void) {
      if (free && event === 'listening') setImmediate(() => cb())
      if (!free && event === 'error')
        setImmediate(() => cb(Object.assign(new Error('in use'), { code: 'EADDRINUSE' })))
      return this
    },
    listen() {
      return this
    },
    close(cb?: () => void) {
      cb?.()
      return this
    },
  })
}

function writtenFile(suffix: string): string | undefined {
  const call = mockWriteFileSync.mock.calls.find(([p]) => p.endsWith(suffix))
  return call?.[1]
}

async function runSetup(args: Record<string, unknown> = {}): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(' '))
  })
  try {
    await (
      setupCommand.run as (ctx: {
        args: Record<string, unknown>
        rawArgs: string[]
        cmd: typeof setupCommand
      }) => Promise<void>
    )({
      // Pin an explicit image so tests unrelated to image resolution do not
      // depend on the CLI's version-derived default; pass `image: undefined`
      // to exercise that default.
      args: { yes: true, image: 'a2wave:test', ...args },
      rawArgs: [],
      cmd: setupCommand,
    })
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

describe('a2wave setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockReaddirSync.mockReturnValue([])
    mockReadFileSync.mockReturnValue('')
    mockLoadConfig.mockReturnValue(null)
    mockReadSecret.mockResolvedValue('Str0ngPass')
    mockIsTTY(false)
    mockPortFree(true)
    // docker + compose preflight pass by default
    mockExecSync.mockReturnValue('')
    // health check succeeds immediately by default
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
  })

  it('rejects an unknown option before running preflight or writing install files', async () => {
    await expect(
      runCommand(setupCommand, {
        rawArgs: [
          '--yes',
          '--with-postgress',
          '--no-start',
          '--dir',
          '/tmp/a2wave',
          '--image',
          'a2wave:test',
        ],
      }),
    ).rejects.toThrow(/Unknown option.*--with-postgress/)

    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails preflight when docker is missing', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('docker --version')) throw new Error('not found')
      return ''
    })
    await expect(runSetup()).rejects.toThrow(CliError)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('fails preflight when docker compose is missing', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('compose version')) throw new Error('not found')
      return ''
    })
    await expect(runSetup()).rejects.toThrow(/compose/i)
  })

  it('fails preflight when the chosen port is already in use, before writing files', async () => {
    mockPortFree(false)
    await expect(runSetup({ dir: '/tmp/a2wave', port: '3502' })).rejects.toThrow(/3502/)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing .env in the target dir', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/tmp/a2wave' || p.endsWith('.env'))
    mockReaddirSync.mockReturnValue(['.env'])
    await expect(runSetup({ dir: '/tmp/a2wave' })).rejects.toThrow(/already contains an install/i)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('writes .env + compose (no admin password anywhere), starts, and prints next steps', async () => {
    const out = await runSetup({ dir: '/tmp/a2wave', port: '3510' })

    const env = writtenFile('.env')
    expect(env).toBeDefined()
    expect(env).toMatch(/AUTH_SECRET=[0-9a-f]{64}/)
    expect(env).not.toContain('ADMIN_PASSWORD')
    expect(env).toContain('A2WAVE_PORT=3510')

    const compose = writtenFile('docker-compose.yml')
    expect(compose).toContain('"${A2WAVE_PORT:-3510}:3502"')

    expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('up -d'))).toBe(true)

    expect(out).toContain('http://localhost:3510')
    // First-login setup owns the password; nothing secret-looking is printed
    expect(out).not.toMatch(/Password:/i)
    expect(out).toMatch(/set.*password/i)
  })

  describe('database backend flags', () => {
    it('writes --database-url into .env; the compose file reads it with a SQLite fallback', async () => {
      await runSetup({
        dir: '/tmp/a2wave',
        'database-url': 'postgres://a2wave:pw@db.internal:5432/a2wave',
      })
      const env = writtenFile('.env')
      expect(env).toContain('DATABASE_URL=postgres://a2wave:pw@db.internal:5432/a2wave')
      expect(env).not.toContain('POSTGRES_PASSWORD')
      const compose = writtenFile('docker-compose.yml')
      expect(compose).toContain('DATABASE_URL=${DATABASE_URL:-/app/data/a2wave.db}')
      expect(compose).not.toContain('image: postgres')
    })

    it('omits DATABASE_URL from .env by default so SQLite stays the backend', async () => {
      await runSetup({ dir: '/tmp/a2wave' })
      expect(writtenFile('.env')).not.toContain('DATABASE_URL')
    })

    it('rejects a non-postgres --database-url before writing any file', async () => {
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'database-url': 'mysql://db/a2wave' }),
      ).rejects.toThrow(/postgres/i)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('rejects --database-url combined with --with-postgres', async () => {
      // The sidecar derives its own URL; accepting both would silently drop one.
      await expect(
        runSetup({
          dir: '/tmp/a2wave',
          'database-url': 'postgres://db/a2wave',
          'with-postgres': true,
        }),
      ).rejects.toThrow(/--database-url.*--with-postgres|--with-postgres.*--database-url/)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('--with-postgres generates the sidecar with a fresh password wired into DATABASE_URL', async () => {
      await runSetup({ dir: '/tmp/a2wave', 'with-postgres': true })
      const env = writtenFile('.env')
      const password = env?.match(/^POSTGRES_PASSWORD=([0-9a-f]{32})$/m)?.[1]
      expect(password).toBeDefined()
      expect(env).toContain(`DATABASE_URL=postgres://a2wave:${password}@postgres:5432/a2wave`)
      const compose = writtenFile('docker-compose.yml')
      expect(compose).toContain('image: postgres:16-alpine')
      expect(compose).toContain('condition: service_healthy')
      // The password reaches the sidecar via .env interpolation, never a literal.
      expect(compose).not.toContain(String(password))
    })

    it('warns when an external database URL points at localhost (unreachable from the container)', async () => {
      const out = await runSetup({
        dir: '/tmp/a2wave',
        'database-url': 'postgres://a2wave:pw@localhost:5432/a2wave',
      })
      expect(out).toContain('host.docker.internal')
    })

    it('mentions the EXPERIMENTAL status when PostgreSQL is selected', async () => {
      const out = await runSetup({ dir: '/tmp/a2wave', 'with-postgres': true })
      expect(out).toMatch(/EXPERIMENTAL/i)
    })
  })

  describe('admin password prompt', () => {
    /** Health passes, then POST /auth/setup succeeds. */
    function mockSetupApiOk(): void {
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/api/auth/setup')) {
          return new Response(JSON.stringify({ data: { token: 't', user: {} } }), { status: 200 })
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      })
    }

    function setupCalls(): Array<[string, RequestInit]> {
      return mockFetch.mock.calls.filter(([u]) => String(u).includes('/api/auth/setup')) as Array<
        [string, RequestInit]
      >
    }

    it('never prompts without a TTY, and leaves the password to the web screen', async () => {
      mockIsTTY(false)
      const out = await runSetup({ dir: '/tmp/a2wave' })
      expect(mockReadSecret).not.toHaveBeenCalled()
      expect(setupCalls()).toHaveLength(0)
      expect(out).toMatch(/set.*password/i)
    })

    it('prompts twice and POSTs the password to /api/auth/setup', async () => {
      mockIsTTY(true)
      mockSetupApiOk()
      mockAskQuestion.mockResolvedValue('')
      mockReadSecret.mockResolvedValue('Str0ngPass')

      await runSetup({ dir: '/tmp/a2wave', port: '3510', yes: false })

      expect(mockReadSecret).toHaveBeenCalledTimes(2)
      const calls = setupCalls()
      expect(calls).toHaveLength(1)
      expect(String(calls[0][0])).toBe('http://localhost:3510/api/auth/setup')
      expect(JSON.parse(String(calls[0][1].body))).toEqual({
        password: 'Str0ngPass',
        confirmPassword: 'Str0ngPass',
      })
    })

    it('re-prompts when the confirmation does not match, without calling the API', async () => {
      mockIsTTY(true)
      mockSetupApiOk()
      mockReadSecret
        .mockResolvedValueOnce('Str0ngPass')
        .mockResolvedValueOnce('Mismatch1')
        .mockResolvedValueOnce('Str0ngPass')
        .mockResolvedValueOnce('Str0ngPass')

      const out = await runSetup({ dir: '/tmp/a2wave', yes: false })

      expect(out).toMatch(/match/i)
      const calls = setupCalls()
      expect(calls).toHaveLength(1)
      // The retry's password must be what is sent, not the first (mismatched) one
      expect(JSON.parse(String(calls[0][1].body)).password).toBe('Str0ngPass')
    })

    it('gives up after 3 failed attempts without calling the API', async () => {
      mockIsTTY(true)
      mockSetupApiOk()
      // three rounds of mismatch: 6 reads, no round ever produces a valid pair
      mockReadSecret
        .mockResolvedValueOnce('Str0ngPass')
        .mockResolvedValueOnce('Nope1AAAA')
        .mockResolvedValueOnce('Str0ngPass')
        .mockResolvedValueOnce('Nope2AAAA')
        .mockResolvedValueOnce('Str0ngPass')
        .mockResolvedValueOnce('Nope3AAAA')

      const out = await runSetup({ dir: '/tmp/a2wave', yes: false })

      expect(mockReadSecret).toHaveBeenCalledTimes(6)
      expect(setupCalls()).toHaveLength(0)
      expect(out).toMatch(/3 attempts/i)
      // The install itself still succeeded — only the password step was skipped
      expect(out).toMatch(/up and running/i)
    })

    it('degrades to the manual hint when the platform is unreachable', async () => {
      mockIsTTY(true)
      mockReadSecret.mockResolvedValue('Str0ngPass')
      mockFetch.mockImplementation(async (url: string) => {
        // health passes, then the password POST rejects at the socket level
        if (String(url).includes('/api/auth/setup')) throw new Error('ECONNREFUSED')
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      })

      const out = await runSetup({ dir: '/tmp/a2wave', port: '3510', yes: false })

      expect(out).toMatch(/ECONNREFUSED|could not reach/i)
      expect(out).toMatch(/http:\/\/localhost:3510/)
    })

    it('--yes skips the prompt even on a TTY (non-interactive contract)', async () => {
      mockIsTTY(true)
      mockSetupApiOk()
      const out = await runSetup({ dir: '/tmp/a2wave', yes: true })
      // Automation that allocates a PTY must never block on a hidden prompt
      expect(mockReadSecret).not.toHaveBeenCalled()
      expect(setupCalls()).toHaveLength(0)
      expect(out).toMatch(/set.*password/i)
    })

    it('reports only the status and error code, never the raw response body', async () => {
      mockIsTTY(true)
      mockReadSecret.mockResolvedValue('Str0ngPass')
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/api/auth/setup')) {
          return new Response(
            JSON.stringify({ error: 'SETUP_ALREADY_COMPLETED', echoed: 'Str0ngPass' }),
            { status: 400 },
          )
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      })

      const out = await runSetup({ dir: '/tmp/a2wave', yes: false })

      expect(out).toContain('400')
      expect(out).toContain('SETUP_ALREADY_COMPLETED')
      // Defense in depth: an arbitrary body must never be reflected verbatim
      expect(out).not.toContain('Str0ngPass')
      expect(out).not.toContain('echoed')
    })

    it('re-prompts on a policy-violating password instead of sending it', async () => {
      mockIsTTY(true)
      mockSetupApiOk()
      // too short, then no digit, then valid
      mockReadSecret
        .mockResolvedValueOnce('Ab1')
        .mockResolvedValueOnce('Ab1')
        .mockResolvedValueOnce('NoDigitsHere')
        .mockResolvedValueOnce('NoDigitsHere')
        .mockResolvedValueOnce('Str0ngPass')
        .mockResolvedValueOnce('Str0ngPass')

      await runSetup({ dir: '/tmp/a2wave', yes: false })

      const calls = setupCalls()
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0][1].body)).password).toBe('Str0ngPass')
    })

    it('never writes the password into .env, compose, or terminal output', async () => {
      mockIsTTY(true)
      mockSetupApiOk()
      mockReadSecret.mockResolvedValue('Str0ngPass')

      const out = await runSetup({ dir: '/tmp/a2wave', yes: false })

      expect(writtenFile('.env')).not.toContain('Str0ngPass')
      expect(writtenFile('docker-compose.yml')).not.toContain('Str0ngPass')
      expect(out).not.toContain('Str0ngPass')
      expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('Str0ngPass'))).toBe(false)
    })

    it('does not accept a password VALUE via CLI flag (shell history / ps leak)', () => {
      const args = (setupCommand as { args?: Record<string, Record<string, unknown>> }).args ?? {}
      // The hazard is a flag that CARRIES a password — argv is visible in `ps`
      // and lands in shell history. A boolean switch whose name mentions
      // "password" (e.g. --reset-password) takes no value and is harmless, so
      // match on the type rather than the name.
      const valueBearingPasswordFlags = Object.entries(args).filter(
        ([name, spec]) => /password/i.test(name) && spec?.type !== 'boolean',
      )
      expect(valueBearingPasswordFlags).toEqual([])
    })

    it('degrades to the manual hint when the API rejects the password', async () => {
      mockIsTTY(true)
      mockReadSecret.mockResolvedValue('Str0ngPass')
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/api/auth/setup')) {
          return new Response(JSON.stringify({ error: 'SETUP_ALREADY_COMPLETED' }), { status: 400 })
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      })

      // A failed password POST must not fail the whole install — the platform is up.
      const out = await runSetup({ dir: '/tmp/a2wave', port: '3510', yes: false })
      expect(out).toMatch(/http:\/\/localhost:3510/)
      expect(out).toMatch(/password/i)
    })

    it('skips the prompt entirely when --no-start left nothing running', async () => {
      mockIsTTY(true)
      mockReadSecret.mockResolvedValue('Str0ngPass')
      await runSetup({ dir: '/tmp/a2wave', start: false, yes: false })
      expect(mockReadSecret).not.toHaveBeenCalled()
      expect(setupCalls()).toHaveLength(0)
    })
  })

  it('pins image and port on the first `up -d` so parent env cannot override them', async () => {
    // The compose file now reads ${A2WAVE_IMAGE:-...}, so an exported
    // A2WAVE_IMAGE in the operator's shell would start THAT image while the
    // CLI wrote the requested one into .env — health could still pass and the
    // install would report success on an image nobody asked for.
    await runSetup({ dir: '/tmp/a2wave', port: '3510', image: 'a2wave:wanted' })
    const up = mockExecSync.mock.calls.find(([c]) => c.includes('up -d'))
    const env = (up?.[1] as { env?: Record<string, string> })?.env
    expect(env?.A2WAVE_IMAGE).toBe('a2wave:wanted')
    expect(env?.A2WAVE_PORT).toBe('3510')
  })

  it('writes .env with mode 0600 and re-chmods it (secret hygiene)', async () => {
    await runSetup({ dir: '/tmp/a2wave' })
    const envCall = mockWriteFileSync.mock.calls.find(([p]) => p.endsWith('.env'))
    expect(envCall?.[2]).toMatchObject({ mode: 0o600 })
    expect(mockChmodSync).toHaveBeenCalledWith(expect.stringMatching(/\.env$/), 0o600)
  })

  it('fails with a retry hint when docker compose up itself errors', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('up -d')) throw new Error('port bind failed')
      return ''
    })
    await expect(runSetup({ dir: '/tmp/a2wave' })).rejects.toThrow(/retry/i)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('defaults --image to the published GHCR image for this CLI version', async () => {
    await runSetup({ dir: '/tmp/a2wave', image: undefined })
    expect(writtenFile('.env')).toContain(`A2WAVE_IMAGE=${DEFAULT_IMAGE}`)
  })

  it('pins the default image to this CLI version, never a floating tag', async () => {
    // The platform and the CLI share one version line, so `a2wave@X.Y.Z` must
    // install the X.Y.Z image. A `latest` default would silently pair a CLI
    // with a platform build it was never tested against.
    expect(DEFAULT_IMAGE).toBe(`ghcr.io/lilithgames/a2wave:${getVersion()}`)
    expect(DEFAULT_IMAGE).not.toMatch(/:latest$/)
  })

  it('uses the docker tag spelling, which carries no leading v', async () => {
    // docker.yml strips the leading `v` from the git tag, so the image is
    // `:0.7.1`. Defaulting to `:v0.7.1` would 404 at pull time.
    expect(DEFAULT_IMAGE).not.toMatch(/:v[0-9]/)
  })

  it('respects --image override', async () => {
    await runSetup({ dir: '/tmp/a2wave', image: 'a2wave:local-test' })
    // The compose file reads the image from .env; the ref lands there and stays
    // in the compose file only as the inline fallback.
    expect(writtenFile('.env')).toContain('A2WAVE_IMAGE=a2wave:local-test')
    expect(writtenFile('docker-compose.yml')).toContain('a2wave:local-test')
  })

  it('--no-start generates files but does not run compose or poll health', async () => {
    await runSetup({ dir: '/tmp/a2wave', start: false })
    expect(writtenFile('.env')).toBeDefined()
    expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('compose up'))).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('saves the instance URL into CLI config so status/login work immediately', async () => {
    await runSetup({ dir: '/tmp/a2wave' })
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3502' }),
    )
  })

  // Token retention across installs is governed by URL identity — see the
  // 'drops the old token when the instance URL changes' / 'keeps the token
  // when re-installing against the same URL' pair below.

  it('dumps container logs into the error when health never becomes ready', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    mockExecSync.mockImplementation((cmd: string) => {
      if (/logs --tail/.test(cmd)) return 'FATAL: migration failed'
      return ''
    })
    await expect(runSetup({ dir: '/tmp/a2wave', 'health-timeout': '0' })).rejects.toThrow(
      /migration failed/,
    )
  })

  it('rejects a degraded health response instead of declaring success', async () => {
    // The API returns HTTP 200 with status:"degraded" when the DB/disk checks
    // fail — res.ok alone would call that a successful install.
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'degraded' }), { status: 200 }),
    )
    await expect(runSetup({ dir: '/tmp/a2wave', 'health-timeout': '0' })).rejects.toThrow(
      /degraded/i,
    )
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('persists COMPOSE_PROJECT_NAME in the generated .env', async () => {
    await runSetup({ dir: '/tmp/a2wave' })
    expect(writtenFile('.env')).toMatch(/COMPOSE_PROJECT_NAME=a2wave-[a-z0-9]{8}/)
  })

  it('passes -p <project> explicitly to compose up so a shell COMPOSE_PROJECT_NAME cannot override it', async () => {
    // Shell env beats .env in Compose precedence; only explicit -p beats both
    process.env.COMPOSE_PROJECT_NAME = 'from-shell'
    try {
      await runSetup({ dir: '/tmp/a2wave' })
    } finally {
      delete process.env.COMPOSE_PROJECT_NAME
    }
    const upCall = mockExecSync.mock.calls.find(
      ([cmd]) => cmd.includes('compose') && cmd.includes('up -d'),
    )
    expect(upCall?.[0]).toMatch(/compose -p a2wave-[a-z0-9]{8} .*up -d/)
  })

  it('teardown reads the persisted project name from .env and passes it via -p to compose down', async () => {
    mockExistsSync.mockImplementation(
      (p: string) =>
        p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install') || p.endsWith('.env'),
    )
    mockReadFileSync.mockReturnValue('AUTH_SECRET=x\nCOMPOSE_PROJECT_NAME=a2wave-deadbeef\n')
    await runSetup({ dir: '/tmp/a2wave', down: true, 'yes-destroy-all-data': true })
    const downCall = mockExecSync.mock.calls.find(([cmd]) => cmd.includes('down -v'))
    expect(downCall?.[0]).toContain('-p a2wave-deadbeef')
    expect(downCall?.[0]).toContain('down -v')
  })

  it('teardown fails closed when no trusted project name can be read from .env', async () => {
    // Without a trusted -p, an external COMPOSE_PROJECT_NAME could redirect
    // `down -v` at another project's volumes — refuse instead of falling back.
    mockExistsSync.mockImplementation(
      (p: string) => p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install'),
    )
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    await expect(
      runSetup({ dir: '/tmp/a2wave', down: true, 'yes-destroy-all-data': true }),
    ).rejects.toThrow(/COMPOSE_PROJECT_NAME/)
    expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('down'))).toBe(false)
    expect(mockRmSync).not.toHaveBeenCalled()
  })

  it('teardown fails closed when .env exists but lacks COMPOSE_PROJECT_NAME', async () => {
    mockExistsSync.mockImplementation(
      (p: string) =>
        p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install') || p.endsWith('.env'),
    )
    mockReadFileSync.mockReturnValue('AUTH_SECRET=x\n')
    await expect(
      runSetup({ dir: '/tmp/a2wave', down: true, 'yes-destroy-all-data': true }),
    ).rejects.toThrow(/COMPOSE_PROJECT_NAME/)
    expect(mockRmSync).not.toHaveBeenCalled()
  })

  it('failure hints for up/down retries include the explicit -p project flag', async () => {
    // up failure
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('up -d')) throw new Error('boom')
      return ''
    })
    await expect(runSetup({ dir: '/tmp/a2wave' })).rejects.toThrow(/-p a2wave-[a-z0-9]{8}/)

    // down failure
    vi.clearAllMocks()
    mockReaddirSync.mockReturnValue([])
    mockExistsSync.mockImplementation(
      (p: string) =>
        p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install') || p.endsWith('.env'),
    )
    mockReadFileSync.mockReturnValue('COMPOSE_PROJECT_NAME=a2wave-deadbeef\n')
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('down -v')) throw new Error('boom')
      return ''
    })
    await expect(
      runSetup({ dir: '/tmp/a2wave', down: true, 'yes-destroy-all-data': true }),
    ).rejects.toThrow(/-p a2wave-deadbeef/)
  })

  it('rejects a non-numeric --health-timeout instead of polling forever', async () => {
    await expect(runSetup({ dir: '/tmp/a2wave', 'health-timeout': 'abc' })).rejects.toThrow(
      /health-timeout/i,
    )
    // must fail during arg validation, before any file is written
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('rejects a negative --health-timeout', async () => {
    await expect(runSetup({ dir: '/tmp/a2wave', 'health-timeout': '-5' })).rejects.toThrow(
      /health-timeout/i,
    )
  })

  it('rejects an --image ref containing YAML-injection characters', async () => {
    await expect(
      runSetup({ dir: '/tmp/a2wave', image: 'a2wave:x\n    privileged: true' }),
    ).rejects.toThrow(/image/i)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('--base-url drives CORS_ORIGIN, the saved CLI url, and the printed address', async () => {
    const out = await runSetup({ dir: '/tmp/a2wave', 'base-url': 'http://192.168.1.10:3502' })
    expect(writtenFile('.env')).toContain('CORS_ORIGIN=http://192.168.1.10:3502')
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://192.168.1.10:3502' }),
    )
    expect(out).toContain('http://192.168.1.10:3502')
  })

  it('health poll always targets localhost even with an external --base-url', async () => {
    // The reverse proxy/DNS may not route yet during install; the container is local
    await runSetup({
      dir: '/tmp/a2wave',
      port: '3510',
      'base-url': 'https://a2wave.example.com',
    })
    const polled = mockFetch.mock.calls.map(([u]) => String(u))
    expect(polled.every((u) => u.startsWith('http://localhost:3510/'))).toBe(true)
  })

  it('non-TTY setup without --yes errors instead of hanging or exiting silently', async () => {
    mockIsTTY(false)
    await expect(runSetup({ dir: '/tmp/a2wave', yes: false })).rejects.toThrow(/--yes/)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('re-prompts on an invalid interactive port instead of aborting', async () => {
    mockIsTTY(true)
    const answers = ['/tmp/a2wave', '35O2', '3510'] // dir, bad port, good port
    mockAskQuestion.mockImplementation(async () => answers.shift() ?? '')
    await runSetup({ yes: false })
    expect(writtenFile('docker-compose.yml')).toContain('${A2WAVE_PORT:-3510}:3502')
  })

  it('refuses to overwrite an existing docker-compose.yml even when .env is absent', async () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === '/tmp/myproject' || p.endsWith('docker-compose.yml'),
    )
    mockReaddirSync.mockReturnValue(['docker-compose.yml'])
    await expect(runSetup({ dir: '/tmp/myproject' })).rejects.toThrow(/docker-compose/)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('refuses a non-empty install dir so --down can never delete pre-existing files', async () => {
    // Directory exists and contains unrelated files (no .env / compose at all)
    mockExistsSync.mockImplementation((p: string) => p === '/tmp/mydata')
    mockReaddirSync.mockReturnValue(['photos', 'notes.txt'])
    await expect(runSetup({ dir: '/tmp/mydata' })).rejects.toThrow(/not empty/i)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('accepts an existing but empty install dir', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/tmp/empty')
    mockReaddirSync.mockReturnValue([])
    await runSetup({ dir: '/tmp/empty' })
    expect(writtenFile('.env')).toBeDefined()
  })

  it('rejects a --base-url that is not a pure origin (path/query/hash/credentials)', async () => {
    for (const bad of [
      'https://example.com/a2wave',
      'https://example.com/?x=1',
      'https://example.com/#frag',
      'https://user:pass@example.com',
    ]) {
      await expect(runSetup({ dir: '/tmp/a2wave', 'base-url': bad })).rejects.toThrow(/origin/i)
    }
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('accepts a --base-url with a trailing slash by normalizing it away', async () => {
    await runSetup({ dir: '/tmp/a2wave', 'base-url': 'https://a2wave.example.com/' })
    expect(writtenFile('.env')).toContain('CORS_ORIGIN=https://a2wave.example.com')
  })

  it('drops the old token when the instance URL changes (never send it to a new host)', async () => {
    mockLoadConfig.mockReturnValue({ url: 'http://old-instance:9999', token: 'tok_old' })
    await runSetup({ dir: '/tmp/a2wave' })
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3502', token: '' }),
    )
  })

  it('keeps the token when re-installing against the same URL', async () => {
    mockLoadConfig.mockReturnValue({ url: 'http://localhost:3502', token: 'tok_same' })
    await runSetup({ dir: '/tmp/a2wave' })
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok_same' }))
  })

  it('reports EACCES on privileged ports distinctly from a port conflict', async () => {
    mockCreateServer.mockReturnValue({
      once(event: string, cb: (err?: Error) => void) {
        if (event === 'error')
          setImmediate(() => cb(Object.assign(new Error('denied'), { code: 'EACCES' })))
        return this
      },
      listen() {
        return this
      },
      close(cb?: () => void) {
        cb?.()
        return this
      },
    })
    await expect(runSetup({ dir: '/tmp/a2wave', port: '80' })).rejects.toThrow(/permission|denied/i)
  })

  it('does not overwrite the CLI config when the health wait fails; the error carries the recovery command', async () => {
    // Failing must not clobber a working config pointing at another instance
    mockLoadConfig.mockReturnValue({ url: 'http://working-instance:3502', token: 'tok_live' })
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(runSetup({ dir: '/tmp/a2wave', 'health-timeout': '0' })).rejects.toThrow(
      /config set-url/,
    )
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('an https --base-url keeps secure cookies enabled', async () => {
    await runSetup({ dir: '/tmp/a2wave', 'base-url': 'https://a2wave.example.com' })
    expect(writtenFile('.env')).not.toContain('AUTH_COOKIE_SECURE=false')
  })

  it('normalizes a logged-out {} config so the saved config keeps the token field', async () => {
    mockLoadConfig.mockReturnValue({}) // logout writes {} — token/url both absent
    await runSetup({ dir: '/tmp/a2wave' })
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3502', token: '' }),
    )
  })

  it('fails fast when the container exits or crash-loops during the health wait', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    mockExecSync.mockImplementation((cmd: string) => {
      if (/ps --all/.test(cmd)) return '[{"State":"exited","ExitCode":1}]'
      if (/logs --tail/.test(cmd)) return 'FATAL: bad config'
      return ''
    })
    // generous timeout: the crash detection, not the deadline, must end the wait
    await expect(runSetup({ dir: '/tmp/a2wave', 'health-timeout': '600' })).rejects.toThrow(
      /exited|crash/i,
    )
  })

  describe('--reset-password', () => {
    const installDirHasMarker = (p: string) =>
      p === '/tmp/a2wave' || p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install')

    beforeEach(() => {
      mockExistsSync.mockImplementation(installDirHasMarker)
      mockReadFileSync.mockReturnValue('COMPOSE_PROJECT_NAME=a2wave-abc123\n')
      // The recovery path itself requires an interactive terminal and rejects
      // --yes (there is no non-interactive way to supply the new password);
      // most cases below exercise that path, so default to it and let the two
      // guard-specific tests override.
      mockIsTTY(true)
    })

    it('runs the in-image recovery script through compose exec', async () => {
      await runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false })
      const cmd = mockExecSync.mock.calls.map(([c]) => c).find((c) => c.includes('exec'))
      expect(cmd).toBeDefined()
      expect(cmd).toContain('-p a2wave-abc123')
      expect(cmd).toContain('set-admin-password.js')
      // `exec` bypasses docker-entrypoint.sh's privilege drop and defaults to
      // root; the recovery script must run as the same non-root user as the
      // server itself.
      expect(cmd).toContain('--user appuser')
      // Must inherit stdio: the script prompts interactively and needs the TTY
      const opts = mockExecSync.mock.calls.find(([c]) => c.includes('exec'))?.[1] as {
        stdio?: string
      }
      expect(opts?.stdio).toBe('inherit')
    })

    it('never writes files, starts a container, or polls health', async () => {
      await runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false })
      expect(mockWriteFileSync).not.toHaveBeenCalled()
      expect(mockRmSync).not.toHaveBeenCalled()
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(false)
    })

    it('refuses a directory that setup did not create', async () => {
      mockExistsSync.mockImplementation(
        (p: string) => p === '/tmp/other' || p.endsWith('docker-compose.yml'),
      )
      await expect(
        runSetup({ dir: '/tmp/other', 'reset-password': true, yes: false }),
      ).rejects.toThrow(/a2wave-install/i)
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('exec'))).toBe(false)
    })

    it('fails closed when no trusted project name can be read', async () => {
      mockReadFileSync.mockReturnValue('# no project name here\n')
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false }),
      ).rejects.toThrow(/COMPOSE_PROJECT_NAME/)
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('exec'))).toBe(false)
    })

    it('errors when there is no install at the given dir', async () => {
      mockExistsSync.mockReturnValue(false)
      await expect(
        runSetup({ dir: '/tmp/nope', 'reset-password': true, yes: false }),
      ).rejects.toThrow(/no a2wave install/i)
    })

    it('tells the user to start the container when it is not running', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('exec')) throw new Error('exit 1')
        // `ps` reports it stopped
        if (cmd.includes('ps')) return '{"Service":"a2wave","State":"exited"}'
        return ''
      })
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false }),
      ).rejects.toThrow(/up -d/)
    })

    it('points at docker itself when the daemon is unreachable', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('exec') || cmd.includes('ps')) {
          throw new Error('Cannot connect to the Docker daemon')
        }
        return ''
      })
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false }),
      ).rejects.toThrow(/get-docker|install it/i)
    })

    it('does not blame the container when the script itself exited non-zero', async () => {
      // The script exits non-zero on a mismatch, a weak password, Ctrl-C, or a
      // missing script in an older image. Telling the user to start a container
      // that `ps` reports as running sends them the wrong way.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('exec')) throw new Error('Command failed with exit code 1')
        if (cmd.includes('ps')) return '{"Service":"a2wave","State":"running"}'
        return ''
      })
      const err = await runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false }).catch(
        (e: Error) => e,
      )
      expect((err as Error).message).toMatch(/exited without setting the password/i)
      expect((err as Error).message).not.toMatch(/up -d/)
    })

    it('succeeds quietly when the script exits zero', async () => {
      // The container script owns all user-facing output here (stdio: inherit),
      // so a successful run must neither throw nor add a diagnosis of its own.
      const out = await runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false })
      expect(out).toBe('')
    })

    it('refuses --reset-password together with --down instead of picking one', async () => {
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'reset-password': true, down: true, yes: false }),
      ).rejects.toThrow(/mutually exclusive/i)
      // Neither action may have run
      expect(mockRmSync).not.toHaveBeenCalled()
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('exec'))).toBe(false)
    })

    it('rejects --reset-password --yes instead of silently blocking on a hidden prompt', async () => {
      // There is no non-interactive way to supply the new password; automation
      // that allocates a PTY must get a clear error, not hang.
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: true }),
      ).rejects.toThrow(/--yes/)
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('exec'))).toBe(false)
    })

    it('rejects --reset-password without a TTY', async () => {
      mockIsTTY(false)
      await expect(
        runSetup({ dir: '/tmp/a2wave', 'reset-password': true, yes: false }),
      ).rejects.toThrow(/not a terminal/i)
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('exec'))).toBe(false)
    })
  })

  describe('--down', () => {
    // teardown requires the compose file, the .a2wave-install marker, AND a
    // trusted COMPOSE_PROJECT_NAME readable from .env (fail-closed otherwise)
    const installDirExists = (p: string) =>
      p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install') || p.endsWith('.env')
    beforeEach(() => {
      mockReadFileSync.mockReturnValue('COMPOSE_PROJECT_NAME=a2wave-deadbeef\n')
    })

    it('refuses to tear down a directory without the a2wave install marker', async () => {
      // Any random compose project has docker-compose.yml but no marker
      mockExistsSync.mockImplementation((p: string) => p.endsWith('docker-compose.yml'))
      await expect(
        runSetup({ dir: '/tmp/someones-project', down: true, 'yes-destroy-all-data': true }),
      ).rejects.toThrow(/marker|not created by/i)
      expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('compose down'))).toBe(false)
      expect(mockRmSync).not.toHaveBeenCalled()
    })

    it('setup writes the install marker so --down can verify ownership later', async () => {
      await runSetup({ dir: '/tmp/a2wave' })
      expect(
        mockWriteFileSync.mock.calls.some(([p]) => String(p).endsWith('.a2wave-install')),
      ).toBe(true)
    })

    it('with --yes-destroy-all-data: runs compose down -v and removes the install dir', async () => {
      mockExistsSync.mockImplementation(installDirExists)
      const out = await runSetup({ dir: '/tmp/a2wave', down: true, 'yes-destroy-all-data': true })
      expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('down -v'))).toBe(true)
      expect(mockRmSync).toHaveBeenCalledWith(
        '/tmp/a2wave',
        expect.objectContaining({ recursive: true }),
      )
      expect(out).toMatch(/removed/i)
    })

    it('--yes alone does NOT skip the confirmation — non-interactive teardown requires --yes-destroy-all-data', async () => {
      mockExistsSync.mockImplementation(installDirExists)
      // runSetup passes yes: true by default; stdin is not a TTY in tests,
      // so without the explicit destroy flag teardown must refuse.
      await expect(runSetup({ dir: '/tmp/a2wave', down: true })).rejects.toThrow(
        /--yes-destroy-all-data/,
      )
      expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('compose down'))).toBe(false)
      expect(mockRmSync).not.toHaveBeenCalled()
    })

    it('interactive confirmation requires typing the install dir path, not just y', async () => {
      mockExistsSync.mockImplementation(installDirExists)
      const answers = ['y', '/tmp/a2wave'] // first a lazy "y" (rejected), then the real phrase
      mockAskQuestion.mockImplementation(async () => answers.shift() ?? '')
      mockIsTTY(true)
      const out = await runSetup({ dir: '/tmp/a2wave', down: true, yes: false })
      // the lazy "y" was not accepted: it had to ask again
      expect(mockAskQuestion).toHaveBeenCalledTimes(2)
      expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('down -v'))).toBe(true)
      expect(out).toMatch(/removed/i)
    })

    it('interactive confirmation aborts after repeated wrong phrases without touching anything', async () => {
      mockExistsSync.mockImplementation(installDirExists)
      mockAskQuestion.mockResolvedValue('nope')
      mockIsTTY(true)
      const out = await runSetup({ dir: '/tmp/a2wave', down: true, yes: false })
      expect(out).toMatch(/aborted/i)
      expect(mockExecSync.mock.calls.some(([cmd]) => cmd.includes('compose down'))).toBe(false)
      expect(mockRmSync).not.toHaveBeenCalled()
    })

    it('errors when the install dir has no docker-compose.yml', async () => {
      mockExistsSync.mockReturnValue(false)
      await expect(
        runSetup({ dir: '/tmp/nope', down: true, 'yes-destroy-all-data': true }),
      ).rejects.toThrow(/no a2wave install/i)
      expect(mockRmSync).not.toHaveBeenCalled()
    })

    it('does not touch generation or health paths', async () => {
      mockExistsSync.mockImplementation(installDirExists)
      await runSetup({ dir: '/tmp/a2wave', down: true, 'yes-destroy-all-data': true })
      expect(mockWriteFileSync).not.toHaveBeenCalled()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})

describe('a2wave setup --upgrade', () => {
  const DIR = '/tmp/a2wave'
  const COMPOSE =
    'services:\n  a2wave:\n    image: a2wave:1.2.0\n    volumes:\n      - a2wave-data:/app/data\n'
  const ENV =
    'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nAUTH_SECRET=secret-must-survive\nA2WAVE_PORT=3510\nA2WAVE_IMAGE=a2wave:1.2.0\n'

  /** A complete, marker-bearing install on disk. */
  function mockInstalled(): void {
    mockExistsSync.mockImplementation(
      (p: string) =>
        p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install') || p.endsWith('.env'),
    )
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? ENV : p.endsWith('docker-compose.yml') ? COMPOSE : '',
    )
  }

  /**
   * A docker whose /app/data mount resolves, with per-test overrides layered on
   * top. There is no conventional-name fallback: an unresolvable mount aborts
   * the backup, so a test that replaces the exec mock wholesale would abort
   * before reaching whatever it actually asserts. Returning `undefined` from
   * `overrides` falls through to this baseline.
   */
  function mockDocker(
    overrides: (cmd: string, opts?: unknown) => string | undefined = () => undefined,
  ): void {
    mockExecSync.mockImplementation((cmd: string, opts?: unknown) => {
      const override = overrides(cmd, opts)
      if (override !== undefined) return override
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Name: 'a2wave-deadbeef_a2wave-data', Destination: '/app/data' }])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1","State":"running"}'
      return ''
    })
  }

  beforeEach(() => {
    // This describe is a sibling of the one above, so it does not inherit its
    // reset — without this, call history from the teardown tests (which DO run
    // `down -v`) leaks in and the volume-safety assertions read the wrong calls.
    vi.clearAllMocks()
    // clearAllMocks resets calls but not implementations, so a test that makes
    // chmod throw would leak into every later one.
    mockChmodSync.mockReset()
    mockIsTTY(false)
    mockLoadConfig.mockReturnValue(null)
    // Default: a running container whose /app/data mount resolves, so tests not
    // about volume resolution reach the code they actually target.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Name: 'a2wave-deadbeef_a2wave-data', Destination: '/app/data' }])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1","State":"running"}'
      return ''
    })
    mockInstalled()
    // A Response body can only be read once, so the shared mockResolvedValue
    // instance would throw on the upgrade path's poll. Mint a fresh one per call.
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    )
  })

  it('never passes -v to compose: the data volume must survive an upgrade', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    // Positive witness first: a bare `not.toMatch` loop over an empty call list
    // passes trivially, so without this the assertion below would still be green
    // if the whole upgrade path were deleted.
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
    for (const [cmd] of mockExecSync.mock.calls) {
      expect(cmd).not.toMatch(/down\s+-v|--volumes/)
    }
  })

  it('does not delete the install directory', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
    expect(mockRmSync).not.toHaveBeenCalled()
  })

  it('touches only A2WAVE_IMAGE in .env — AUTH_SECRET and COMPOSE_PROJECT_NAME survive', async () => {
    // The image now lives in .env, so that file IS written; what must never
    // change is anything else in it. A regenerated AUTH_SECRET invalidates
    // every session, and a regenerated COMPOSE_PROJECT_NAME points compose at
    // a DIFFERENT volume, orphaning the database while reporting success.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const write = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('.env'))
    expect(write?.[1]).toContain('A2WAVE_IMAGE=a2wave:1.3.0')
    const strip = (v: string) => v.split('\n').filter((l) => !l.startsWith('A2WAVE_IMAGE='))
    expect(strip(String(write?.[1]))).toEqual(strip(ENV))
  })

  it('rewrites only A2WAVE_IMAGE in .env, leaving the secrets byte-identical', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const write = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('.env'))
    expect(write?.[1]).toContain('A2WAVE_IMAGE=a2wave:1.3.0')
    expect(write?.[1]).toContain('AUTH_SECRET=secret-must-survive')
    expect(write?.[1]).toContain('COMPOSE_PROJECT_NAME=a2wave-deadbeef')
  })

  it('uses the persisted project name via -p so it targets this install only', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const up = mockExecSync.mock.calls.find(([cmd]) => cmd.includes('up -d'))
    expect(up?.[0]).toContain('-p a2wave-deadbeef')
  })

  it('fails closed when the install has no ownership marker', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.a2wave-install'))
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /marker|not created by/i,
    )
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('fails closed when no trusted COMPOSE_PROJECT_NAME can be read', async () => {
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? 'AUTH_SECRET=x\n' : COMPOSE,
    )
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /COMPOSE_PROJECT_NAME/,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(false)
  })

  it('errors when there is no install at the target dir', async () => {
    mockExistsSync.mockReturnValue(false)
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /no a2wave install/i,
    )
  })

  it('upgrades to this CLI version’s image when --image is omitted', async () => {
    // Upgrading after `a2wave update` should move the platform to the version
    // the freshly-updated CLI was built against, without retyping the ref.
    await runSetup({ dir: DIR, upgrade: true, image: undefined })
    const envWrite = mockWriteFileSync.mock.calls.find(([p]) => p.endsWith('.env'))
    expect(envWrite?.[1]).toContain(`A2WAVE_IMAGE=${DEFAULT_IMAGE}`)
  })

  it('rejects an image ref that could inject YAML', async () => {
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1\n    privileged: true' }),
    ).rejects.toThrow(/image/i)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('pulls the new image before recreating the container', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const cmds = mockExecSync.mock.calls.map(([c]) => c)
    const pull = cmds.findIndex((c) => c.includes('pull'))
    const up = cmds.findIndex((c) => c.includes('up -d'))
    expect(pull).toBeGreaterThanOrEqual(0)
    expect(pull).toBeLessThan(up)
  })

  it('restores the previous compose file when the new image fails to become healthy', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    // Last compose write must put the ORIGINAL image back
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(composeWrites.at(-1)?.[1]).toContain('A2WAVE_IMAGE=a2wave:1.2.0')
  })

  it('rolls back by bringing the previous image up again, still without -v', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const ups = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))
    expect(ups.length).toBeGreaterThanOrEqual(2)
    // Only compose's volume-deleting form is forbidden; `docker run -v vol:/data:ro`
    // is a read-only mount used by the backup and is not a deletion.
    for (const [cmd] of mockExecSync.mock.calls.filter(([c]) => c.includes('docker compose'))) {
      expect(cmd).not.toMatch(/down\s+-v|--volumes/)
    }
  })

  it('reports the version transition on success', async () => {
    const out = await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(out).toContain('a2wave:1.2.0')
    expect(out).toContain('a2wave:1.3.0')
  })

  it('still pulls and recreates when the ref is unchanged (mutable tags move)', async () => {
    // `--image` is documented as a locally built tag like a2wave:latest, so the
    // ref staying equal says nothing about the image behind it. Returning early
    // on a string compare skipped pull/recreate/health/rollback entirely — the
    // whole point of the command — right after a rebuild.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.2.0' })
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('pull'))).toBe(true)
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0)
  })

  it('recovers an interrupted upgrade whose compose file already names the new image', async () => {
    // Killed after the rewrite but before the container was recreated: the file
    // says the new image while the instance may be down. An early return here
    // left no way forward — re-running reported "nothing to upgrade" and the
    // instance stayed stopped.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? ENV
        : 'services:\n  a2wave:\n    image: a2wave:1.3.0\n    volumes:\n      - a2wave-data:/app/data\n',
    )
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
  })

  it('does not touch the CLI config (the instance URL is unchanged by an upgrade)', async () => {
    mockLoadConfig.mockReturnValue({ url: 'http://localhost:3510', token: 'tok_keep' })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('health-probes the port recorded in the install .env, not the CLI default', async () => {
    // The install lives on 3510; probing DEFAULT_PORT would report a false
    // failure and trigger a needless rollback of a perfectly good upgrade.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(':3510/api/health'),
      expect.anything(),
    )
  })

  it('rejects --port with --upgrade rather than silently moving only the probe', async () => {
    // .env is deliberately never rewritten, so --port could not republish the
    // container anyway — it would only redirect the health probe. Accepting it
    // would look like a port change that silently did not happen.
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', port: '3999' }),
    ).rejects.toThrow(/--port/)
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(false)
  })

  it('falls back to the default port when .env records no A2WAVE_PORT at all', async () => {
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\n' : COMPOSE,
    )
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(':3502/api/health'),
      expect.anything(),
    )
  })

  it('does not inject a guessed A2WAVE_PORT, which would republish the container', async () => {
    // The compose file bakes the install-time port in as `${A2WAVE_PORT:-3510}`.
    // Injecting a guessed 3502 beats that fallback (env wins in Compose), so the
    // container comes back on a different host port while the CLI probes the
    // guessed one and happily reports success — every existing client breaks.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\n' : COMPOSE,
    )
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const up = mockExecSync.mock.calls.find(([c]) => c.includes('up -d'))
    const env = (up?.[1] as { env?: Record<string, string> })?.env
    expect(env && 'A2WAVE_PORT' in env).toBe(false)
  })

  it('fails closed on a malformed A2WAVE_PORT instead of probing the default port', async () => {
    // Falling back to 3502 here would probe a DIFFERENT service — either
    // rolling back a healthy upgrade, or reporting success against an
    // unrelated a2wave that happens to be listening there.
    for (const bad of ['notanumber', '99999', '0', '-1']) {
      vi.clearAllMocks()
      mockInstalled()
      mockExecSync.mockReturnValue('')
      mockReadFileSync.mockImplementation((p: string) =>
        p.endsWith('.env') ? `COMPOSE_PROJECT_NAME=a2wave-deadbeef\nA2WAVE_PORT=${bad}\n` : COMPOSE,
      )
      await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
        /A2WAVE_PORT/,
      )
      expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(false)
    }
  })

  it('does not bind-probe the port: the running install already owns it', async () => {
    // checkPortFree() would see the live container and abort a valid upgrade.
    mockPortFree(false)
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
  })

  it('brings the old version back up when `up -d` on the new image fails', async () => {
    // compose stops the old container before starting the replacement, so a
    // failed `up -d` leaves the instance DOWN. Restoring only the file would
    // turn a failed upgrade into an outage.
    let attempts = 0
    mockDocker((cmd) => {
      if (cmd.includes('up -d')) {
        attempts++
        if (attempts === 1) throw new Error('port bind failed')
      }
      return undefined
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow()
    const ups = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))
    expect(ups.length).toBeGreaterThanOrEqual(2)
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(composeWrites.at(-1)?.[1]).toContain('A2WAVE_IMAGE=a2wave:1.2.0')
  })

  it('reports accurately when the recovery `up -d` also fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('up -d')) throw new Error('boom')
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /manual|WARNING|recover/i,
    )
  })

  it('health-verifies the rollback rather than trusting `up -d` exit 0', async () => {
    // A rolled-back container can still crash — e.g. the new image already ran
    // an irreversible migration the old one cannot read. Claiming success from
    // exit 0 alone would tell the user they are fine when they are not.
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow(/did not come back healthy|still unhealthy|manual/i)
    // Two health probes: one for the new image, one verifying the rollback
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('scopes pull and up to the a2wave service so sidecars are not touched', async () => {
    // A bare `compose pull` / `up -d` acts on the whole project: a hand-added
    // redis sidecar would be pulled to a new image and recreated by what the
    // user asked to be an a2wave upgrade.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    for (const [cmd] of mockExecSync.mock.calls.filter(
      ([c]) => c.includes('pull') || c.includes('up -d'),
    )) {
      expect(cmd).toMatch(/\ba2wave\s*$/)
    }
  })

  it('passes --no-deps so a depends_on sidecar is not started or recreated', async () => {
    // Naming the service is not enough: compose starts its dependencies too, so
    // a user-added `depends_on` would see its sidecar recreated by what the
    // docs promise touches "that service only".
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    for (const [cmd] of mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))) {
      expect(cmd).toContain('--no-deps')
    }
  })

  it('pins A2WAVE_PORT for compose so a shell override cannot move the container', async () => {
    // Compose reads A2WAVE_PORT from the environment ahead of the install .env,
    // so an exported value would publish the container on a different port
    // while the CLI still probes the recorded one — a false rollback.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const up = mockExecSync.mock.calls.find(([c]) => c.includes('up -d'))
    expect((up?.[1] as { env?: Record<string, string> })?.env?.A2WAVE_PORT).toBe('3510')
  })

  it('rejects --upgrade with --reset-password before entering either branch', async () => {
    // yes:false + TTY so neither the --yes guard nor the not-a-terminal guard
    // can answer for us: without an explicit exclusion the reset branch would
    // run the recovery script instead of rejecting the combination.
    mockIsTTY(true)
    await expect(
      runSetup({
        dir: DIR,
        upgrade: true,
        image: 'a2wave:1.3.0',
        'reset-password': true,
        yes: false,
      }),
    ).rejects.toThrow(/cannot be combined/i)
    // The recovery script must never have been invoked
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('exec'))).toBe(false)
  })

  it('rejects --upgrade with --base-url (an upgrade never rewrites .env)', async () => {
    await expect(
      runSetup({
        dir: DIR,
        upgrade: true,
        image: 'a2wave:1.3.0',
        'base-url': 'https://a2wave.example.com',
      }),
    ).rejects.toThrow(/base-url/)
  })

  it('rejects --upgrade with --database-url / --with-postgres (an upgrade never rewrites .env)', async () => {
    await expect(
      runSetup({
        dir: DIR,
        upgrade: true,
        image: 'a2wave:1.3.0',
        'database-url': 'postgres://db/a2wave',
      }),
    ).rejects.toThrow(/database-url/)
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'with-postgres': true }),
    ).rejects.toThrow(/with-postgres/)
  })

  it('warns that the pre-upgrade backup covers the data volume only, not PostgreSQL', async () => {
    // The backup archives the volume mounted at /app/data; a PostgreSQL
    // backend keeps the real data elsewhere (external server or the sidecar's
    // own volume), so reporting a good snapshot without this caveat would let
    // an operator upgrade believing the database is covered.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? `${ENV}DATABASE_URL=postgres://a2wave:pw@postgres:5432/a2wave\n`
        : p.endsWith('docker-compose.yml')
          ? COMPOSE
          : '',
    )
    const out = await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(out).toMatch(/PostgreSQL/)
    expect(out).toMatch(/backup/i)
  })

  it('rejects --upgrade with --no-start (an upgrade is a restart by definition)', async () => {
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', start: false }),
    ).rejects.toThrow(/no-start|start/)
  })

  it('waits for readiness, not just liveness, before declaring success', async () => {
    // /api/health goes green when the port opens, but the API keeps seeding
    // afterwards and only then marks ready. Accepting liveness would declare
    // the upgrade successful during a window where seeding can still fail and
    // take the process down — with no rollback.
    const seen: string[] = []
    mockFetch.mockImplementation(async (url: string) => {
      seen.push(String(url))
      if (String(url).includes('/ready')) {
        return new Response(JSON.stringify({ status: 'ready' }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(seen.some((u) => u.includes('/api/health/ready'))).toBe(true)
  })

  it('rolls back when the container is live but never becomes ready', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/ready')) {
        return new Response(JSON.stringify({ status: 'starting' }), { status: 503 })
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const ups = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))
    expect(ups.length).toBeGreaterThanOrEqual(2)
  })

  it('treats a 404 from /ready as an older image rather than never-ready', async () => {
    // Images predating the readiness route must still be upgradable.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/ready')) return new Response('Not Found', { status: 404 })
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))).toHaveLength(1)
  })

  it('does not hang forever when the new container accepts connections but never responds', async () => {
    // A deadline checked only after `await fetch()` returns is no deadline at
    // all: a container that accepts the socket and then stalls holds the CLI
    // open indefinitely, so --health-timeout never fires and the rollback that
    // should restore service never runs.
    mockFetch.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    // Every probe must have carried an abort signal
    for (const [, init] of mockFetch.mock.calls) {
      expect((init as { signal?: AbortSignal } | undefined)?.signal).toBeDefined()
    }
  })

  it('pins the running image id before upgrading so a same-tag rollback is real', async () => {
    // With a mutable tag the compose text is identical before and after, so
    // restoring the file and running `up -d` would resolve the SAME (broken)
    // image. The pre-upgrade image id has to be captured and pinned.
    mockDocker((cmd) => {
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      if (cmd.includes('{{.Image}}')) return 'sha256:0123456789abcdef\n'
      return undefined
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    // The running container's real image must be read from the container, not
    // from `compose images` (which reports what the tag resolves to *now*).
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('{{.Image}}'))).toBe(true)
  })

  it('rolls back to the captured image id, not the tag, when the tag is unchanged', async () => {
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? ENV
        : 'services:\n  a2wave:\n    image: a2wave:latest\n    volumes:\n      - a2wave-data:/app/data\n',
    )
    mockDocker((cmd) => {
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      if (cmd.includes('{{.Image}}')) return 'sha256:0123456789abcdef\n'
      return undefined
    })
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:latest', 'health-timeout': '0' }),
    ).rejects.toThrow()
    // The restored compose file must name the captured id, not the moving tag
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    // A bare digest is not a valid compose image value, so it must be pinned
    // to an immutable local tag instead.
    expect(mockExecSync.mock.calls.some(([c]) => c.startsWith('docker tag '))).toBe(true)
    expect(composeWrites.at(-1)?.[1]).toContain('A2WAVE_IMAGE=a2wave:rollback-0123456789ab')
  })

  it('pins the compose file with -f so COMPOSE_FILE cannot redirect the upgrade', async () => {
    // COMPOSE_FILE in the caller's environment beats cwd, so without an
    // explicit -f the CLI would edit the install's docker-compose.yml while
    // compose pulled/recreated/probed an entirely different stack — possibly
    // mounting another project's data volume and then reporting success.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    // Every project-scoped call must be pinned; `docker compose version` is a
    // capability probe with no project and is deliberately excluded.
    const scoped = mockExecSync.mock.calls.filter(([c]) => c.includes('-p '))
    expect(scoped.length).toBeGreaterThan(0)
    for (const [cmd] of scoped) {
      expect(cmd).toContain(`-f '${DIR}/docker-compose.yml'`)
    }
  })

  it('pins the previous image whenever it was captured, not only on an identical ref', async () => {
    // `a2wave` and `a2wave:latest` are different strings that resolve to the
    // same moving tag, and any old tag may have been rebuilt since. Gating the
    // pin on string equality leaves those rollbacks resolving to the image that
    // just failed.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? ENV
        : 'services:\n  a2wave:\n    image: a2wave\n    volumes:\n      - a2wave-data:/app/data\n',
    )
    mockDocker((cmd) => {
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      if (cmd.includes('{{.Image}}')) return 'sha256:0123456789abcdef\n'
      return undefined
    })
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:latest', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(composeWrites.at(-1)?.[1]).toContain('A2WAVE_IMAGE=a2wave:rollback-0123456789ab')
  })

  it('quotes the install path so a directory containing a space still works', async () => {
    // execSync goes through /bin/sh, so an unquoted -f argument word-splits on
    // the space: -f receives only the first segment, every compose call fails,
    // and the pull try/catch reports it as a missing image — sending the
    // operator after their image tag instead of the real cause.
    const spaced = '/tmp/My Installs/a2wave'
    await runSetup({ dir: spaced, upgrade: true, image: 'a2wave:1.3.0' })
    for (const [cmd] of mockExecSync.mock.calls.filter(([c]) => c.includes('-p '))) {
      expect(cmd).toContain(`'${spaced}/docker-compose.yml'`)
    }
  })

  it('preserves the .env secrets on the rollback path too', async () => {
    // Rollback is where recovery code gets edited later, so the invariant needs
    // its own guard there — not just on the success path.
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const writes = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(writes.length).toBeGreaterThan(0)
    for (const [, content] of writes) {
      expect(String(content)).toContain('AUTH_SECRET=secret-must-survive')
      expect(String(content)).toContain('COMPOSE_PROJECT_NAME=a2wave-deadbeef')
    }
  })

  it('keeps --no-deps on the rollback up, not just the upgrade up', async () => {
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const ups = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))
    expect(ups.length).toBeGreaterThanOrEqual(2)
    for (const [cmd] of ups) expect(cmd).toContain('--no-deps')
  })

  it('bounds the readiness probe too, not only the liveness probe', async () => {
    // Liveness must pass so the readiness probe is actually reached; without
    // that the assertion below only ever inspects /api/health calls.
    mockFetch.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes('/ready')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        })
      }
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const readyCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes('/ready'))
    expect(readyCalls.length).toBeGreaterThan(0)
    for (const [, init] of readyCalls) {
      expect((init as { signal?: AbortSignal } | undefined)?.signal).toBeDefined()
    }
  })

  it('migrates a hardcoded compose image line to the A2WAVE_IMAGE variable', async () => {
    // Installs generated before the image became an env key hardcode the ref in
    // docker-compose.yml, where a new A2WAVE_IMAGE value would be ignored — the
    // upgrade would report success while the container stayed on the old image.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nAUTH_SECRET=s\nA2WAVE_PORT=3510\n'
        : 'services:\n  a2wave:\n    image: a2wave:1.2.0\n    volumes:\n      - a2wave-data:/app/data\n',
    )
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const compose = mockWriteFileSync.mock.calls.find(([p]) =>
      String(p).endsWith('docker-compose.yml'),
    )
    expect(compose?.[1]).toContain('${A2WAVE_IMAGE:-')
    expect(compose?.[1]).toContain('a2wave-data:/app/data')
    const env = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('.env'))
    expect(env?.[1]).toContain('A2WAVE_IMAGE=a2wave:1.3.0')
  })

  it('backs up the data volume before touching anything', async () => {
    // An upgrade is the one routine operation that can lose data: a new image
    // may apply an irreversible migration the previous version cannot read, so
    // rolling the image back does not roll the database back.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const backup = mockExecSync.mock.calls.find(([c]) => c.includes('tar'))
    expect(backup?.[0]).toContain('a2wave-deadbeef_a2wave-data')
    expect(backup?.[0]).toContain('.tar.gz')
  })

  it('stops the container before the backup so SQLite is not copied mid-write', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const cmds = mockExecSync.mock.calls.map(([c]) => c)
    const stop = cmds.findIndex((c) => c.includes(' stop'))
    const tar = cmds.findIndex((c) => c.includes('tar'))
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(stop).toBeLessThan(tar)
  })

  it('aborts the upgrade when the backup fails, without changing the image', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('tar')) throw new Error('no space left on device')
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /backup/i,
    )
    const envWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(envWrites).toHaveLength(0)
  })

  it('--no-backup skips it for operators who manage snapshots themselves', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', backup: false })
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('tar'))).toBe(false)
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
  })

  it('restarts the container when the backup fails after the stop', async () => {
    // The stop happens before the snapshot, so aborting there without a restart
    // leaves the install DOWN while the error claims it was not touched.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('tar')) throw new Error('no space left on device')
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /backup/i,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
  })

  it('restarts the container when the image cannot be pulled after the stop', async () => {
    mockDocker((cmd) => {
      if (cmd.includes('pull')) throw new Error('manifest unknown')
      if (cmd.includes('image inspect')) throw new Error('No such image')
      return undefined
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:x' })).rejects.toThrow(
      /not found|pull/i,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
  })

  it('restores docker-compose.yml when a migrated file is abandoned mid-upgrade', async () => {
    // The migration writes the compose file before the pull; aborting after it
    // must not leave the file half-migrated.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nAUTH_SECRET=s\nA2WAVE_PORT=3510\n'
        : 'services:\n  a2wave:\n    image: a2wave:1.2.0\n',
    )
    mockDocker((cmd) => {
      if (cmd.includes('pull')) throw new Error('manifest unknown')
      if (cmd.includes('image inspect')) throw new Error('No such image')
      return undefined
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:x' })).rejects.toThrow()
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) =>
      String(p).endsWith('docker-compose.yml'),
    )
    expect(composeWrites.at(-1)?.[1]).not.toContain('A2WAVE_IMAGE')
  })

  it('finds the previous image even though the backup already stopped the container', async () => {
    // `compose ps` hides stopped containers without --all, and the default
    // backup path stops the container first — so the digest pin was always
    // null and a same-tag rollback re-resolved to the failing image.
    mockDocker((cmd) => {
      if (cmd.includes('ps ') && !cmd.includes('--all')) return '[]'
      if (cmd.includes('ps ') && cmd.includes('--all')) return '[{"Name":"proj-a2wave-1"}]'
      if (cmd.includes('{{.Image}}')) return 'sha256:0123456789abcdef\n'
      return undefined
    })
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const envWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(envWrites.at(-1)?.[1]).toContain('a2wave:rollback-0123456789ab')
  })

  it('pins A2WAVE_IMAGE so an exported value cannot hijack the upgraded image', async () => {
    // Compose prefers the process environment over the install .env, so a shell
    // exporting A2WAVE_IMAGE would start THAT image while the CLI rewrote .env
    // to --image — health then passes against the hijacked ref and the upgrade
    // reports success on an image nobody asked for.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const up = mockExecSync.mock.calls.find(([c]) => c.includes('up -d'))
    const env = (up?.[1] as { env?: Record<string, string> })?.env
    expect(env?.A2WAVE_IMAGE).toBe('a2wave:1.3.0')
  })

  it('strips an inherited A2WAVE_PORT when the install recorded none', async () => {
    // Omitting the key is not enough: it would still be inherited from the
    // parent and beat the compose file's own ${A2WAVE_PORT:-<installPort>}.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\n' : COMPOSE,
    )
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const up = mockExecSync.mock.calls.find(([c]) => c.includes('up -d'))
    const env = (up?.[1] as { env?: Record<string, string> })?.env
    expect(env?.A2WAVE_PORT).toBeUndefined()
  })

  it('makes the backup archive owner-only', async () => {
    // It contains the SQLite database: credentials, tokens, every secret the
    // platform holds. Alpine's default umask would leave it world-readable.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockChmodSync).toHaveBeenCalledWith(
      expect.stringMatching(/a2wave-data-.*\.tar\.gz$/),
      0o600,
    )
  })

  it('does not pin the new image on the rollback up, or the rollback restarts it', async () => {
    // The pin exists so an exported A2WAVE_IMAGE cannot hijack the upgrade —
    // but reusing it for the rollback would override the restored .env and
    // start the very image that just failed.
    mockDocker((cmd) => {
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      if (cmd.includes('{{.Image}}')) return 'sha256:0123456789abcdef\n'
      return undefined
    })
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const ups = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))
    const rollbackEnv = (ups.at(-1)?.[1] as { env?: Record<string, string> })?.env
    expect(rollbackEnv?.A2WAVE_IMAGE).not.toBe('a2wave:1.3.0')
  })

  it('runs the backup as the calling user so the archive is not root-owned', async () => {
    // Without --user, tar runs as root inside the container and the bind mount
    // writes a root:root 0644 file onto the host. A non-root CLI user then
    // cannot chmod it, so the whole database snapshot stays world-readable.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const backup = mockExecSync.mock.calls.find(([c]) => c.includes('tar'))
    expect(backup?.[0]).toMatch(/--user \d+:\d+/)
  })

  it('fails loudly when the archive cannot be locked down', async () => {
    // Swallowing the chmod error left a 0644 snapshot of every credential the
    // platform holds while the upgrade reported success.
    mockChmodSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.tar.gz')) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /owner-only|not permitted/i,
    )
  })

  it('pins the restored image on the rollback up -d (positive assertion)', async () => {
    // The only prior check was negative (`not.toBe(newImage)`), which stays
    // green if the pin is dropped or carries the wrong tag — exactly the bug
    // the pin exists to prevent. Assert the pinned tag itself.
    mockDocker((cmd) => {
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      if (cmd.includes('{{.Image}}')) return 'sha256:0123456789abcdef\n'
      return undefined
    })
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const rollbackUp = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d')).at(-1)
    const env = (rollbackUp?.[1] as { env?: Record<string, string> })?.env
    expect(env?.A2WAVE_IMAGE).toBe('a2wave:rollback-0123456789ab')
  })

  it('never rewrites docker-compose.yml when it already uses the variable', async () => {
    // The default fixture is a legacy hardcoded file, so the standard success
    // case exercises the MIGRATION write — the "never regenerated" invariant
    // was never actually asserted.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? ENV : 'services:\n  a2wave:\n    image: ${A2WAVE_IMAGE:-a2wave:1.2.0}\n',
    )
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) =>
      String(p).endsWith('docker-compose.yml'),
    )
    expect(composeWrites).toHaveLength(0)
  })

  it('prunes old backups so secret-bearing snapshots do not pile up', async () => {
    // Each archive is a full database copy; keeping every one of them grows
    // without bound and multiplies the blast radius of a directory leak.
    mockReaddirSync.mockReturnValue([
      'a2wave-data-2026-01-01T00-00-00-000Z.tar.gz',
      'a2wave-data-2026-02-01T00-00-00-000Z.tar.gz',
      'a2wave-data-2026-03-01T00-00-00-000Z.tar.gz',
      'a2wave-data-2026-04-01T00-00-00-000Z.tar.gz',
      'docker-compose.yml',
    ] as never)
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const removed = mockRmSync.mock.calls.map(([p]) => String(p))
    expect(removed.some((p) => p.includes('2026-01-01'))).toBe(true)
    // Never touches anything that is not one of our archives
    expect(removed.some((p) => p.endsWith('docker-compose.yml'))).toBe(false)
  })

  it('leaves human-named archives alone when pruning', async () => {
    // `a2wave-data-*.tar.gz` also matches a deliberately kept copy such as
    // `a2wave-data-manual-golden.tar.gz`; silently deleting an operator's
    // archive is worse than keeping one file too many.
    mockReaddirSync.mockReturnValue([
      // Names that sort BEFORE the timestamps, so a lexical prune would
      // delete them first — the assertion below would be vacuous otherwise.
      'a2wave-data-000-keep-me.tar.gz',
      'a2wave-data-baseline.tar.gz',
      'a2wave-data-2026-01-01T00-00-00-000Z.tar.gz',
      'a2wave-data-2026-02-01T00-00-00-000Z.tar.gz',
      'a2wave-data-2026-03-01T00-00-00-000Z.tar.gz',
      'a2wave-data-2026-04-01T00-00-00-000Z.tar.gz',
    ] as never)
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const removed = mockRmSync.mock.calls.map(([p]) => String(p))
    expect(removed.some((p) => p.includes('000-keep-me'))).toBe(false)
    expect(removed.some((p) => p.includes('baseline'))).toBe(false)
    expect(removed.some((p) => p.includes('2026-01-01'))).toBe(true)
  })

  it('sanitizes the environment on the abort restart too, not just the upgrade', async () => {
    // The abort path restarts the previous container. Bypassing composeEnv()
    // there lets an exported A2WAVE_IMAGE/A2WAVE_PORT from the operator's shell
    // beat the restored .env and bring the old instance back on the wrong image
    // or port — the same hijack the upgrade path already guards against.
    mockReadFileSync.mockImplementation((p: string) =>
      // No A2WAVE_IMAGE recorded → currentImage is null → the branch under test.
      p.endsWith('.env') ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nA2WAVE_PORT=3510\n' : COMPOSE,
    )
    mockDocker((cmd) => {
      if (cmd.includes('pull')) throw new Error('manifest unknown')
      if (cmd.includes('image inspect')) throw new Error('No such image')
      return undefined
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:x' })).rejects.toThrow()
    const restart = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d')).at(-1)
    const env = (restart?.[1] as { env?: Record<string, string> })?.env
    expect(env).toBeDefined()
    // Unknown previous ref: the key must be removed so compose falls back to
    // the file's own default rather than inheriting a stray export.
    expect(env && 'A2WAVE_IMAGE' in env).toBe(false)
    expect(env?.A2WAVE_PORT).toBe('3510')
  })

  it('never passes the display placeholder as an image ref on rollback', async () => {
    // With no A2WAVE_IMAGE recorded AND no digest captured, `target` was the
    // human-readable string "the previous image". Feeding that to compose sets
    // an illegal ref, so the rollback cannot start at all — even though the
    // compose file's own fallback would have worked.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nA2WAVE_PORT=3510\n' : COMPOSE,
    )
    mockExecSync.mockImplementation((cmd: string) => {
      // Exited (so the health wait fails fast) and with no Name field, so the
      // digest capture finds nothing → currentImage and pin are both null.
      if (cmd.includes('ps ')) return '[{"State":"exited"}]'
      if (cmd.includes('inspect')) throw new Error('No such object')
      return ''
    })
    // Liveness never comes back, so the upgrade fails into rollBack. The stop
    // itself must succeed or the fail-closed guard fires first.
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0', 'health-timeout': '0' }),
    ).rejects.toThrow()
    const rollbackUp = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d')).at(-1)
    const env = (rollbackUp?.[1] as { env?: Record<string, string> })?.env
    // Unknown ref → the key must be absent so compose uses its own fallback
    expect(env && 'A2WAVE_IMAGE' in env).toBe(false)
  })

  it('does not back up when stopping the container failed', async () => {
    // A swallowed `stop` failure means tar copies a LIVE SQLite file: the
    // resulting DB/WAL/SHM set can be unrecoverable, and the command would
    // still report a good snapshot.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes(' stop ')) throw new Error('invalid interpolation format')
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /stop|snapshot/i,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('tar'))).toBe(false)
  })

  it('sanitizes the environment for the pre-backup stop as well', async () => {
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const stop = mockExecSync.mock.calls.find(([c]) => c.includes(' stop '))
    const env = (stop?.[1] as { env?: Record<string, string> })?.env
    expect(env?.A2WAVE_PORT).toBe('3510')
  })

  it('backs up the volume the container actually mounts, not a guessed name', async () => {
    // The recovery guide switches installs to `external: true` +
    // `name: <project>_a2wave-restore`. A hardcoded `<project>_a2wave-data`
    // would archive the OLD volume — or, once that is deleted, an empty one
    // docker creates silently, reported as a good snapshot.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('Mounts')) {
        return JSON.stringify([
          { Name: 'a2wave-deadbeef_a2wave-restore', Destination: '/app/data' },
        ])
      }
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      return ''
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const backup = mockExecSync.mock.calls.find(([c]) => c.includes('tar'))
    expect(backup?.[0]).toContain('a2wave-deadbeef_a2wave-restore')
    expect(backup?.[0]).not.toContain('a2wave-deadbeef_a2wave-data')
  })

  it('refuses to back up when neither the mount nor the conventional volume resolves', async () => {
    // Guessing is how an empty archive gets reported as a good snapshot:
    // `docker run -v <missing>` creates the volume instead of failing.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('Mounts')) return '[]'
      if (cmd.includes('volume inspect')) throw new Error('no such volume')
      if (cmd.includes('ps ')) return '[{"Name":"proj-a2wave-1"}]'
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /volume/i,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('tar'))).toBe(false)
  })

  it('restores a migrated compose file when the pre-backup stop fails', async () => {
    // The migration writes docker-compose.yml before the stop; bailing there
    // without restoring leaves the operator's file changed while the error
    // says the upgrade was never started.
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env')
        ? 'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nAUTH_SECRET=s\nA2WAVE_PORT=3510\n'
        : 'services:\n  a2wave:\n    image: a2wave:1.2.0\n',
    )
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes(' stop ')) throw new Error('invalid interpolation format')
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow()
    const composeWrites = mockWriteFileSync.mock.calls.filter(([p]) =>
      String(p).endsWith('docker-compose.yml'),
    )
    expect(composeWrites.at(-1)?.[1]).not.toContain('A2WAVE_IMAGE')
  })

  it('shell-quotes the inspect format so the template is not word-split', async () => {
    // `--format {{json .Mounts}}` contains a space; unquoted, /bin/sh splits it
    // and docker reports "unclosed action" — so resolution failed on EVERY real
    // run and silently fell back to the guessed name it exists to replace.
    // Asserting the command string is the only way to catch this, since the
    // mock never goes near a shell.
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const inspect = mockExecSync.mock.calls.find(([c]) => c.includes('.Mounts'))
    expect(inspect?.[0]).toContain("'{{json .Mounts}}'")
  })

  it('picks the /app/data mount, not merely the first one', async () => {
    // Replacing the Destination check with mounts[0] used to pass every test.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([
          { Name: 'a2wave-deadbeef_a2wave-cli-home', Destination: '/home/appuser' },
          { Name: 'a2wave-deadbeef_a2wave-data', Destination: '/app/data' },
        ])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1"}'
      return ''
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const backup = mockExecSync.mock.calls.find(([c]) => c.includes('tar'))
    expect(backup?.[0]).toContain('a2wave-deadbeef_a2wave-data')
    expect(backup?.[0]).not.toContain('cli-home')
  })

  it('refuses when /app/data is a bind mount rather than a named volume', async () => {
    // A bind mount has no Name; falling back to the conventional volume would
    // archive something the container is not even using.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Type: 'bind', Source: '/srv/data', Destination: '/app/data' }])
      }
      if (cmd.includes('volume inspect')) return '' // conventional volume exists
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1"}'
      return ''
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })).rejects.toThrow(
      /bind mount|volume/i,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('tar'))).toBe(false)
  })

  it('reads the newest container from NDJSON compose ps output', async () => {
    // `compose ps --all --format json` emits one object per LINE, and with
    // --all a replaced container can appear first.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Name: 'correct-vol', Destination: '/app/data' }])
      }
      if (cmd.includes('ps ')) {
        return '{"Name":"stale-a2wave-1","State":"exited"}\n{"Name":"live-a2wave-1","State":"running"}'
      }
      return ''
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    const inspect = mockExecSync.mock.calls.find(([c]) => c.includes('.Mounts'))
    expect(inspect?.[0]).toContain('live-a2wave-1')
  })

  it('rejects combining --upgrade with --down', async () => {
    await expect(
      runSetup({ dir: DIR, upgrade: true, down: true, image: 'a2wave:1.3.0' }),
    ).rejects.toThrow(/together|both|combine/i)
  })

  it('continues when pull fails but the image exists locally (locally-built images)', async () => {
    // --image is documented as "e.g. a locally built a2wave:latest", and a
    // local-only tag can never be pulled — aborting there would break the
    // primary use case until a public registry ships.
    mockDocker((cmd) => {
      if (cmd.includes('pull')) throw new Error('pull access denied for a2wave')
      if (cmd.includes('image inspect')) return 'sha256:abc\n'
      return undefined
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('up -d'))).toBe(true)
  })

  it('aborts when pull fails and the image is absent locally, without touching the container', async () => {
    mockDocker((cmd) => {
      if (cmd.includes('pull')) throw new Error('manifest unknown')
      if (cmd.includes('image inspect')) throw new Error('No such image')
      return undefined
    })
    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:nope' })).rejects.toThrow(
      /not found|pull/i,
    )
    // The new image was never started; the only `up -d` is the restart of the
    // container the backup step stopped.
    expect(mockExecSync.mock.calls.filter(([c]) => c.includes('up -d'))).toHaveLength(1)
    // compose file must be back to the original
    const w = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env'))
    expect(w.at(-1)?.[1]).toContain('A2WAVE_IMAGE=a2wave:1.2.0')
  })
})

describe('a2wave setup --upgrade under a polluted parent environment', () => {
  // Compose reads A2WAVE_IMAGE / A2WAVE_PORT from the process environment ahead
  // of the install .env, so an unsanitized call runs against whatever the
  // operator's shell exported.
  //
  // What that costs varies by subcommand AND Compose version — measured on
  // v5.1.0, `config`/`up` reject an invalid A2WAVE_PORT while `ps`/`logs`/`stop`
  // tolerate it. These tests therefore pin the PROPERTY (no call inherits the
  // pollution) rather than one version's failure mode: the mock below fails any
  // polluted call, which is the worst case across versions and the only
  // assumption that stays true as Compose changes.
  //
  // The data-safety consequence is real and reproduced end-to-end against
  // Docker 29.2.1 by a different route — see the fail-closed test below, where
  // an unprovable mount made the pre-fix code archive the stale conventional
  // volume and report success.
  const DIR = '/tmp/a2wave'
  const COMPOSE =
    'services:\n  a2wave:\n    image: ${A2WAVE_IMAGE:-a2wave:1.2.0}\n    volumes:\n      - a2wave-data:/app/data\n'
  const ENV =
    'COMPOSE_PROJECT_NAME=a2wave-deadbeef\nAUTH_SECRET=secret-must-survive\nA2WAVE_PORT=3510\nA2WAVE_IMAGE=a2wave:latest\n'

  /**
   * The environment a compose child would actually see.
   *
   * Crucially, OMITTING `env` is the bug, not a neutral default: execSync then
   * hands the child `process.env` verbatim, pollution included. Modelling an
   * absent `env` as "clean" is what let an unsanitized call site look fine in a
   * test while failing on a real machine.
   */
  function childEnv(opts: unknown): Record<string, string | undefined> {
    const explicit = (opts as { env?: Record<string, string | undefined> })?.env
    return explicit ?? process.env
  }

  /** Fail like compose does when the interpolated port is not a port. */
  function pollutedPort(opts: unknown): boolean {
    return childEnv(opts).A2WAVE_PORT === 'notaport'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockChmodSync.mockReset()
    mockIsTTY(false)
    mockLoadConfig.mockReturnValue(null)
    mockExistsSync.mockImplementation(
      (p: string) =>
        p.endsWith('docker-compose.yml') || p.endsWith('.a2wave-install') || p.endsWith('.env'),
    )
    mockReadFileSync.mockImplementation((p: string) =>
      p.endsWith('.env') ? ENV : p.endsWith('docker-compose.yml') ? COMPOSE : '',
    )
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    )
    // The pollution the operator's shell carries in. DATABASE_URL is the most
    // likely of the three in the wild — every dev machine running this repo
    // has one in scope.
    process.env.A2WAVE_PORT = 'notaport'
    process.env.A2WAVE_IMAGE = 'someone-elses:image'
    process.env.DATABASE_URL = 'postgres://someone-elses-db:5432/prod'
    process.env.SCM_STORAGE_ROOT = '/someone/elses/scm'
    process.env.SCM_WORKSPACES_ALLOWED_ROOTS = '/someone/elses/workspaces'
  })

  afterEach(() => {
    // `delete` is required, not stylistic: assigning undefined leaves the key
    // present with the literal string "undefined", which would leak into every
    // later test as a different flavour of the same pollution.
    // biome-ignore lint/performance/noDelete: the key must be absent, not ""
    delete process.env.A2WAVE_PORT
    // biome-ignore lint/performance/noDelete: same — see above
    delete process.env.A2WAVE_IMAGE
    // biome-ignore lint/performance/noDelete: same — see above
    delete process.env.DATABASE_URL
    // biome-ignore lint/performance/noDelete: same — see above
    delete process.env.SCM_STORAGE_ROOT
    // biome-ignore lint/performance/noDelete: same — see above
    delete process.env.SCM_WORKSPACES_ALLOWED_ROOTS
  })

  it('never lets an exported DATABASE_URL reach a compose child', async () => {
    // The generated compose interpolates ${DATABASE_URL:-...}, and Compose
    // prefers the process environment over the install .env — an inherited
    // value would silently point the recreated container at the exported
    // database while .env still records the real one.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Name: 'a2wave-deadbeef_a2wave-data', Destination: '/app/data' }])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1","State":"running"}'
      return ''
    })
    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })
    // Project-scoped calls only: the bare `docker compose version` preflight
    // interpolates nothing, so its inherited env is inert.
    const composeCalls = mockExecSync.mock.calls.filter(
      ([c]) => c.includes('docker compose') && c.includes('-p '),
    )
    expect(composeCalls.length).toBeGreaterThan(0)
    for (const [, opts] of composeCalls) {
      expect(childEnv(opts).DATABASE_URL).toBeUndefined()
      expect(childEnv(opts).SCM_STORAGE_ROOT).toBeUndefined()
      expect(childEnv(opts).SCM_WORKSPACES_ALLOWED_ROOTS).toBeUndefined()
    }
  })

  it('backs up the external restore volume, not the stale conventional one', async () => {
    // The documented recovery procedure moves an install onto
    // `<project>_a2wave-restore` and leaves the old `<project>_a2wave-data`
    // volume in place. With the ps probe inheriting a bad A2WAVE_PORT, compose
    // failed before listing the container, resolution returned null, and the
    // upgrade archived the OLD volume — reporting a good snapshot while the
    // real data had no backup at all.
    mockExecSync.mockImplementation((cmd: string, opts?: unknown) => {
      if (cmd.includes('docker compose') && cmd.includes('-p ') && pollutedPort(opts)) {
        throw new Error('invalid hostPort: "notaport"')
      }
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([
          { Name: 'a2wave-deadbeef_a2wave-restore', Destination: '/app/data' },
        ])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1","State":"running"}'
      return ''
    })

    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:latest' })

    const backup = mockExecSync.mock.calls.find(([c]) => c.includes('tar'))
    expect(backup?.[0]).toContain('a2wave-deadbeef_a2wave-restore')
    expect(backup?.[0]).not.toContain('a2wave-deadbeef_a2wave-data')
  })

  it('fails closed rather than guessing the volume when the container cannot be listed', async () => {
    // Even sanitized, docker can genuinely be unreachable. There is no
    // conventional-name fallback any more: "the conventional volume exists" is
    // true of exactly the stale volume an external-restore install left behind,
    // so a guess there is the data-loss case, not the safe one.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps ')) throw new Error('Cannot connect to the Docker daemon')
      if (cmd.includes('volume inspect')) return '' // conventional volume DOES exist
      return ''
    })

    await expect(runSetup({ dir: DIR, upgrade: true, image: 'a2wave:latest' })).rejects.toThrow(
      /volume/i,
    )
    expect(mockExecSync.mock.calls.some(([c]) => c.includes('tar'))).toBe(false)
  })

  it('still pins the old digest for a same-tag rollback', async () => {
    // Both current and target are `a2wave:latest` — the documented local-build
    // flow. Pulling moves the tag, so a rollback that only restores the .env
    // re-resolves to the SAME failing image. The digest capture is the only
    // thing that makes the rollback real, and it went through an unsanitized
    // `ps` that silently returned null under a polluted parent env.
    mockExecSync.mockImplementation((cmd: string, opts?: unknown) => {
      if (cmd.includes('docker compose') && cmd.includes('-p ') && pollutedPort(opts)) {
        throw new Error('invalid hostPort: "notaport"')
      }
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Name: 'a2wave-deadbeef_a2wave-data', Destination: '/app/data' }])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1","State":"running"}'
      if (cmd.includes('--format {{.Image}}')) return 'sha256:0123456789abcdef\n'
      return ''
    })
    // Health never comes back, so the upgrade must roll back.
    mockFetch.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })

    await expect(
      runSetup({ dir: DIR, upgrade: true, image: 'a2wave:latest', 'health-timeout': '0' }),
    ).rejects.toThrow()

    // The captured digest was tagged, so the rollback has something immutable
    // to restore to rather than re-resolving the moving tag.
    const tagged = mockExecSync.mock.calls.find(([c]) => c.startsWith('docker tag'))
    expect(tagged?.[0]).toContain('a2wave:rollback-0123456789ab')
    const rollbackUp = mockExecSync.mock.calls.filter(([c]) => c.includes('up -d')).at(-1)
    const env = (rollbackUp?.[1] as { env?: Record<string, string> })?.env
    expect(env?.A2WAVE_IMAGE).toBe('a2wave:rollback-0123456789ab')
  })

  it('never leaks the inherited pollution into any compose child', async () => {
    // The property behind all three cases above, asserted over every compose
    // call an upgrade makes — probes included, since those were the sites that
    // kept being missed.
    mockExecSync.mockImplementation((cmd: string, opts?: unknown) => {
      if (cmd.includes('docker compose') && cmd.includes('-p ') && pollutedPort(opts)) {
        throw new Error('invalid hostPort: "notaport"')
      }
      if (cmd.includes('.Mounts')) {
        return JSON.stringify([{ Name: 'a2wave-deadbeef_a2wave-data', Destination: '/app/data' }])
      }
      if (cmd.includes('ps ')) return '{"Name":"proj-a2wave-1","State":"running"}'
      return ''
    })

    await runSetup({ dir: DIR, upgrade: true, image: 'a2wave:1.3.0' })

    // `-p` marks a project-scoped call; `docker compose version` is a
    // capability probe with no project and nothing to interpolate.
    const composeCalls = mockExecSync.mock.calls.filter(
      ([c]) => c.includes('docker compose') && c.includes('-p '),
    )
    // Positive witness: an empty list would make the loop below pass trivially.
    expect(composeCalls.length).toBeGreaterThan(0)
    for (const [cmd, opts] of composeCalls) {
      // Absent `env` means the child inherits process.env — the bug itself.
      expect((opts as { env?: unknown })?.env, `no env pinned for: ${cmd}`).toBeDefined()
      const env = childEnv(opts)
      // The recorded port from .env wins over the shell's garbage ...
      expect(env?.A2WAVE_PORT, cmd).toBe('3510')
      // ... and the image is never the stranger's.
      expect(env?.A2WAVE_IMAGE, cmd).not.toBe('someone-elses:image')
    }
  })
})
