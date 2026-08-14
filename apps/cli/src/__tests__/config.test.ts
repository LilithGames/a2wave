import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome: string

const { mockHomedir } = vi.hoisted(() => {
  let _home = ''
  return {
    mockHomedir: {
      get: () => _home,
      set: (v: string) => {
        _home = v
      },
    },
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  }
})

describe('config', () => {
  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'a2wave-test-'))
    mockHomedir.set(tempHome)
    // Re-import to pick up new homedir
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true })
  })

  async function getConfig() {
    return await import('../config.js')
  }

  describe('loadConfig', () => {
    it('returns null when config file does not exist', async () => {
      const { loadConfig } = await getConfig()
      expect(loadConfig()).toBeNull()
    })

    it('reads and parses existing config', async () => {
      const { saveConfig, loadConfig } = await getConfig()
      saveConfig({ url: 'https://example.com', token: 'tok123' })
      const config = loadConfig()
      expect(config).toEqual({ url: 'https://example.com', token: 'tok123' })
    })

    it('returns null for invalid JSON', async () => {
      const dir = join(tempHome, '.a2wave')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'config.json'), 'not-json', 'utf-8')
      const { loadConfig } = await getConfig()
      expect(loadConfig()).toBeNull()
    })
  })

  describe('saveConfig', () => {
    it('creates directory and writes config file', async () => {
      const { saveConfig } = await getConfig()
      saveConfig({ url: 'https://a2wave.dev', token: 'abc' })
      const raw = readFileSync(join(tempHome, '.a2wave', 'config.json'), 'utf-8')
      expect(JSON.parse(raw)).toEqual({ url: 'https://a2wave.dev', token: 'abc' })
    })

    it('creates directory with 0o700 and file with 0o600 permissions', async () => {
      const { saveConfig } = await getConfig()
      saveConfig({ url: 'https://a2wave.dev', token: 'secret' })
      const dirStat = statSync(join(tempHome, '.a2wave'))
      const fileStat = statSync(join(tempHome, '.a2wave', 'config.json'))
      expect(dirStat.mode & 0o777).toBe(0o700)
      expect(fileStat.mode & 0o777).toBe(0o600)
    })

    it('overwrites existing config', async () => {
      const { saveConfig, loadConfig } = await getConfig()
      saveConfig({ url: 'https://old.com', token: 'old' })
      saveConfig({ url: 'https://new.com', token: 'new' })
      expect(loadConfig()).toEqual({ url: 'https://new.com', token: 'new' })
    })

    it('tightens permissions when overwriting an existing config file', async () => {
      const dir = join(tempHome, '.a2wave')
      const file = join(dir, 'config.json')
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, '{}')
      chmodSync(file, 0o644)
      const { saveConfig } = await getConfig()

      saveConfig({ url: 'https://a2wave.dev', token: 'secret' })

      expect(statSync(file).mode & 0o777).toBe(0o600)
    })
  })

  describe('clearConfig', () => {
    it('resets config to empty object', async () => {
      const { saveConfig, clearConfig } = await getConfig()
      saveConfig({ url: 'https://a2wave.dev', token: 'abc' })
      clearConfig()
      const raw = readFileSync(join(tempHome, '.a2wave', 'config.json'), 'utf-8')
      expect(JSON.parse(raw)).toEqual({})
    })

    it('does nothing if config file does not exist', async () => {
      const { clearConfig } = await getConfig()
      expect(() => clearConfig()).not.toThrow()
    })
  })

  // client.ts and the command modules mock '../config.js' wholesale, so these are
  // the only tests that execute the real requireToken / resolveUrl.
  describe('requireToken', () => {
    it('returns the stored token', async () => {
      const { saveConfig, requireToken } = await getConfig()
      saveConfig({ url: 'https://a2wave.dev', token: 'tok' })
      expect(requireToken()).toBe('tok')
    })

    it('throws when no config exists', async () => {
      const { requireToken } = await getConfig()
      expect(() => requireToken()).toThrow('Not logged in')
    })

    it('throws when the token is empty (OAuth-less state)', async () => {
      const { saveConfig, requireToken } = await getConfig()
      saveConfig({ url: 'https://a2wave.dev', token: '' })
      expect(() => requireToken()).toThrow('Not logged in')
    })
  })

  describe('resolveUrl', () => {
    const ORIGINAL_ENV = process.env.A2WAVE_URL

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.A2WAVE_URL
      else process.env.A2WAVE_URL = ORIGINAL_ENV
    })

    it('prefers the --url override over env and config', async () => {
      const { saveConfig, resolveUrl } = await getConfig()
      saveConfig({ url: 'https://from-config.dev', token: 'tok' })
      process.env.A2WAVE_URL = 'https://from-env.dev'
      expect(resolveUrl('https://from-flag.dev')).toBe('https://from-flag.dev')
    })

    it('falls back to $A2WAVE_URL when no override is given', async () => {
      const { saveConfig, resolveUrl } = await getConfig()
      saveConfig({ url: 'https://from-config.dev', token: 'tok' })
      process.env.A2WAVE_URL = 'https://from-env.dev'
      expect(resolveUrl()).toBe('https://from-env.dev')
    })

    it('falls back to the config url when neither override nor env is set', async () => {
      const { saveConfig, resolveUrl } = await getConfig()
      delete process.env.A2WAVE_URL
      saveConfig({ url: 'https://from-config.dev', token: 'tok' })
      expect(resolveUrl()).toBe('https://from-config.dev')
    })

    it('strips trailing slashes from every source', async () => {
      const { saveConfig, resolveUrl } = await getConfig()
      delete process.env.A2WAVE_URL
      saveConfig({ url: 'https://from-config.dev///', token: 'tok' })
      expect(resolveUrl('https://from-flag.dev//')).toBe('https://from-flag.dev')
      process.env.A2WAVE_URL = 'https://from-env.dev/'
      expect(resolveUrl()).toBe('https://from-env.dev')
      delete process.env.A2WAVE_URL
      expect(resolveUrl()).toBe('https://from-config.dev')
    })

    it('ignores whitespace-only values and keeps falling back', async () => {
      const { saveConfig, resolveUrl } = await getConfig()
      saveConfig({ url: 'https://from-config.dev', token: 'tok' })
      process.env.A2WAVE_URL = '   '
      expect(resolveUrl('  ')).toBe('https://from-config.dev')
    })

    it('throws with all three setup hints when no source has a URL', async () => {
      const { saveConfig, resolveUrl } = await getConfig()
      delete process.env.A2WAVE_URL
      saveConfig({ url: '', token: 'tok' })
      expect(() => resolveUrl()).toThrow(/No a2wave instance URL specified/)
      expect(() => resolveUrl()).toThrow(/--url/)
      expect(() => resolveUrl()).toThrow(/A2WAVE_URL/)
      expect(() => resolveUrl()).toThrow(/config set-url/)
    })
  })
  // ---------------------------------------------------------------------------
  // Credentials are keyed by URL.
  //
  // The bug this fixes: `requireToken()` took no URL argument (client.ts called
  // it alongside `resolveUrl(opts.url)` with no link between the two), so
  // pointing `--url` at a second instance silently sent the FIRST instance's
  // token. It then failed as a 401 that blamed the user's login rather than
  // naming the real cause.
  // ---------------------------------------------------------------------------
  describe('resolveCredential', () => {
    it('returns the legacy top-level token for the configured URL', async () => {
      // The migration contract: an existing flat {url, token} keeps working
      // untouched. Nothing rewrites the file on read, so downgrading to an
      // older CLI also still works.
      const { saveConfig, resolveCredential } = await getConfig()
      saveConfig({ url: 'https://a.example', token: 'tok-a' })

      expect(resolveCredential('https://a.example')).toBe('tok-a')
    })

    it('REFUSES to reuse that token for a different URL', async () => {
      const { saveConfig, resolveCredential } = await getConfig()
      saveConfig({ url: 'https://a.example', token: 'tok-a' })

      expect(() => resolveCredential('https://b.example')).toThrow(/b\.example/)
    })

    it('names the fix in the error, and types it so an agent can branch', async () => {
      const { saveConfig, resolveCredential } = await getConfig()
      saveConfig({ url: 'https://a.example', token: 'tok-a' })

      try {
        resolveCredential('https://b.example')
        throw new Error('expected a throw')
      } catch (err) {
        const e = err as { type?: string; subtype?: string; hint?: string }
        expect(e.type).toBe('auth')
        expect(e.subtype).toBe('no_credential_for_url')
        expect(e.hint).toContain('a2wave login')
      }
    })

    it('prefers a per-URL credential over the legacy field', async () => {
      const { saveConfig, saveCredential, resolveCredential } = await getConfig()
      saveConfig({ url: 'https://a.example', token: 'tok-a' })
      saveCredential('https://b.example', 'tok-b')

      expect(resolveCredential('https://b.example')).toBe('tok-b')
      expect(resolveCredential('https://a.example')).toBe('tok-a')
    })

    it('ignores a trailing slash, so the same instance is one key', async () => {
      const { saveCredential, resolveCredential } = await getConfig()
      saveCredential('https://a.example/', 'tok-a')

      expect(resolveCredential('https://a.example')).toBe('tok-a')
    })

    it('still reports "not logged in" when there is no config at all', async () => {
      const { resolveCredential } = await getConfig()
      expect(() => resolveCredential('https://a.example')).toThrow(/Not logged in/)
    })
  })

  describe('profiles', () => {
    it('adds a profile without disturbing the legacy fields', async () => {
      // Profiles are a thin alias over URL-keyed credentials, not a new
      // primary abstraction: an agent almost never wants "a profile", it wants
      // "this URL with the right token". Profiles serve humans switching
      // contexts, so they must not complicate the common path.
      const { saveConfig, saveProfile, loadConfig } = await getConfig()
      saveConfig({ url: 'https://a.example', token: 'tok-a' })
      saveProfile('staging', 'https://b.example')

      const cfg = loadConfig()
      expect(cfg?.url).toBe('https://a.example')
      expect(cfg?.token).toBe('tok-a')
      expect(cfg?.profiles?.staging).toEqual({ url: 'https://b.example' })
    })

    it('resolves a profile name to its URL', async () => {
      const { saveProfile, resolveProfileUrl } = await getConfig()
      saveProfile('staging', 'https://b.example')

      expect(resolveProfileUrl('staging')).toBe('https://b.example')
    })

    it('errors on an unknown profile, listing the ones that exist', async () => {
      const { saveProfile, resolveProfileUrl } = await getConfig()
      saveProfile('staging', 'https://b.example')

      expect(() => resolveProfileUrl('nope')).toThrow(/staging/)
    })
  })
})
