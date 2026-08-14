import { afterEach, describe, expect, it, vi } from 'vitest'
import { emit, jsonArg, redactSecrets, wantsJson } from '../output.js'

describe('wantsJson', () => {
  it('is true only for an explicit boolean true', () => {
    expect(wantsJson({ json: true })).toBe(true)
    expect(wantsJson({ json: false })).toBe(false)
    expect(wantsJson({})).toBe(false)
    // citty gives booleans as true/undefined; a stray string must not enable it
    expect(wantsJson({ json: 'true' })).toBe(false)
  })
})

describe('emit', () => {
  afterEach(() => vi.restoreAllMocks())

  // The CLI's primary consumer is an AI agent, and indentation is pure cost to
  // one: 9-25% of the bytes on a 20-agent list, depending on how much long text
  // each row carries. `--json` is therefore compact, and humans who want the
  // indented form ask for it with `--json-pretty`.
  it('prints compact JSON and reports that it handled output', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const handled = emit({ json: true }, { data: [{ id: 'agt_1' }] })

    expect(handled).toBe(true)
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ data: [{ id: 'agt_1' }] }))
  })

  it('prints indented JSON under --json-pretty', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const handled = emit({ json: true, 'json-pretty': true }, { data: [{ id: 'agt_1' }] })

    expect(handled).toBe(true)
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ data: [{ id: 'agt_1' }] }, null, 2))
  })

  it('treats --json-pretty as implying --json', () => {
    // An agent that passes only the pretty flag still wants JSON; requiring
    // both spellings would be a silent no-op that prints the human table.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(emit({ 'json-pretty': true }, { data: [] })).toBe(true)
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ data: [] }, null, 2))
  })

  it('redacts identically in both layouts', () => {
    const payload = { data: { endpointApiKey: 'sk-live-abc' } }
    const compact = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit({ json: true }, payload)
    const compactOut = String(compact.mock.calls.at(-1)?.[0])
    emit({ json: true, 'json-pretty': true }, payload)
    const prettyOut = String(compact.mock.calls.at(-1)?.[0])

    expect(compactOut).not.toContain('sk-live-abc')
    expect(prettyOut).not.toContain('sk-live-abc')
    // Same value, different layout only.
    expect(JSON.parse(compactOut)).toEqual(JSON.parse(prettyOut))
  })

  it('prints nothing and defers to the caller without --json', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(emit({}, { data: [] })).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('exposes a citty-shaped flag definition', () => {
    expect(jsonArg.json.type).toBe('boolean')
    expect(jsonArg['json-pretty'].type).toBe('boolean')
  })
})

describe('redactSecrets', () => {
  it('masks credential-bearing keys at any depth', () => {
    const payload = {
      data: {
        id: 'agt_1',
        name: 'bot',
        endpointApiKey: 'sk-live-abc',
        feishuConfig: { appId: 'cli_x', appSecret: 'very-secret' },
        config: {
          providerChain: [{ providerApiKey: 'sk-1', providerOauthToken: 'oauth-1', model: 'gpt' }],
        },
      },
    }

    const out = redactSecrets(payload) as typeof payload

    expect(out.data.endpointApiKey).toBe('********')
    expect(out.data.feishuConfig.appSecret).toBe('********')
    expect(out.data.config.providerChain[0].providerApiKey).toBe('********')
    expect(out.data.config.providerChain[0].providerOauthToken).toBe('********')
    // Non-secret fields must survive untouched, or --json becomes useless.
    expect(out.data.id).toBe('agt_1')
    expect(out.data.feishuConfig.appId).toBe('cli_x')
    expect(out.data.config.providerChain[0].model).toBe('gpt')
  })

  it('masks env values flagged sensitive, whatever the var is called', () => {
    const out = redactSecrets({
      env: {
        LARK_APP_SECRET: { value: 'shh', sensitive: true },
        LOG_LEVEL: { value: 'debug', sensitive: false },
      },
    }) as { env: Record<string, { value: string }> }

    expect(out.env.LARK_APP_SECRET.value).toBe('********')
    expect(out.env.LOG_LEVEL.value).toBe('debug')
  })

  it('catches suffix-style names the explicit list misses', () => {
    const out = redactSecrets({ notionToken: 'nt', webhookSecret: 'ws', myApiKey: 'mk' }) as Record<
      string,
      string
    >
    expect(Object.values(out)).toEqual(['********', '********', '********'])
  })

  it('leaves non-string values alone, so null still reads as "unset"', () => {
    const out = redactSecrets({ oauthToken: null, apiKey: false, nested: { token: 42 } }) as Record<
      string,
      unknown
    >
    expect(out.oauthToken).toBeNull()
    expect(out.apiKey).toBe(false)
    expect((out.nested as Record<string, unknown>).token).toBe(42)
  })

  it('preserves arrays and does not mutate the input', () => {
    const input = { items: [{ apiKey: 'a' }, { apiKey: 'b' }] }
    const out = redactSecrets(input) as typeof input

    expect(out.items.map((i) => i.apiKey)).toEqual(['********', '********'])
    expect(input.items[0].apiKey).toBe('a')
  })
})

describe('emit secret handling', () => {
  afterEach(() => vi.restoreAllMocks())

  it('redacts by default — CLI output lands in scrollback and CI logs', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit({ json: true }, { data: { endpointApiKey: 'sk-live-abc' } })

    expect(spy.mock.calls[0][0]).toContain('********')
    expect(spy.mock.calls[0][0]).not.toContain('sk-live-abc')
  })

  it('prints plaintext only with an explicit --show-secrets', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit({ json: true, 'show-secrets': true }, { data: { endpointApiKey: 'sk-live-abc' } })

    expect(spy.mock.calls[0][0]).toContain('sk-live-abc')
  })
})

describe('redactSecrets — MCP config shapes', () => {
  it('masks every value under env and headers, whatever the key is called', () => {
    // MCP stores credentials in free-form maps, so name-based matching cannot
    // help: the key is chosen by whoever configured the server.
    const out = redactSecrets({
      data: {
        name: 'github-mcp',
        env: { GITHUB_TOKEN: 'ghp_live', P4PASSWD: 'hunter2', LOG_LEVEL: 'debug' },
        headers: { Authorization: 'Bearer abc', 'X-API-Key': 'k-1' },
      },
    }) as { data: { name: string; env: Record<string, string>; headers: Record<string, string> } }

    expect(Object.values(out.data.env)).toEqual(['********', '********', '********'])
    expect(Object.values(out.data.headers)).toEqual(['********', '********'])
    // Keys stay visible — knowing WHICH vars are set is the useful part.
    expect(Object.keys(out.data.env)).toEqual(['GITHUB_TOKEN', 'P4PASSWD', 'LOG_LEVEL'])
    expect(out.data.name).toBe('github-mcp')
  })

  it('masks the credential-bearing PARTS of a URL, keeping it usable', () => {
    const out = redactSecrets({
      a: { url: 'https://user:pw@mcp.example.com/sse?apikey=x' },
      b: { url: 'https://mcp.example.com/sse' },
      c: { url: 'git@gitlab.com:team/repo.git' },
    }) as Record<string, { url: string }>

    // userinfo + query masked; scheme, host and path survive so the endpoint is
    // still identifiable — reducing everything to origin made every source on
    // one host indistinguishable.
    expect(out.a.url).toBe('https://********@mcp.example.com/sse?********')
    expect(out.b.url).toBe('https://mcp.example.com/sse')
    // scp-style carries a username, not a password — the server leaves it too.
    expect(out.c.url).toBe('git@gitlab.com:team/repo.git')
  })

  it('masks an opaque token embedded in the path', () => {
    const out = redactSecrets({
      url: 'https://open.larksuite.com/sse/aBcD1234efGH5678ijKL',
    }) as { url: string }
    expect(out.url).toBe('https://open.larksuite.com/sse/********')
  })

  it('recurses into groupConfig inline backends', () => {
    const out = redactSecrets({
      groupConfig: {
        backends: {
          prod: [{ mode: 'inline', env: { TOKEN: 'secret' }, url: 'https://h/p?k=v' }],
        },
      },
    }) as {
      groupConfig: { backends: { prod: Array<{ env: Record<string, string>; url: string }> } }
    }

    expect(out.groupConfig.backends.prod[0].env.TOKEN).toBe('********')
    expect(out.groupConfig.backends.prod[0].url).toBe('https://h/p?********')
  })
})

describe('redactSecrets — SCM credentials and URL scoping', () => {
  it('masks pat and p4passwd, which the suffix rule misses', () => {
    // `pat` is three letters with no matching suffix; `p4passwd` ends in
    // "passwd", not "password". The server masks both on read, but its
    // maskScmConfig falls through to plaintext on an unrecognised `type`, so
    // the CLI is the last line of defence.
    const out = redactSecrets({
      data: [
        { config: { type: 'git', pat: 'glpat-LIVE', branch: 'main' } },
        { config: { type: 'p4', p4passwd: 'LIVEPASS', p4user: 'bob' } },
      ],
    }) as { data: Array<{ config: Record<string, string> }> }

    expect(out.data[0].config.pat).toBe('********')
    expect(out.data[1].config.p4passwd).toBe('********')
    // Non-secret siblings must survive.
    expect(out.data[0].config.branch).toBe('main')
    expect(out.data[1].config.p4user).toBe('bob')
  })

  it('strips the PAT from a repoUrl while preserving the round-trip sentinel', () => {
    const out = redactSecrets({
      config: { repoUrl: 'https://oauth2:ghp_LIVE@gitlab.com/x/y.git' },
    }) as { config: { repoUrl: string } }

    expect(out.config.repoUrl).not.toContain('ghp_LIVE')
    // Keeps the server's `********@host/path` shape. isMaskedRepoUrl() checks
    // `username === '********'` to mean "keep the stored value", so collapsing
    // this to origin/******** silently persisted a broken URL through
    // `scm update --config-file`.
    expect(out.config.repoUrl).toBe('https://********@gitlab.com/x/y.git')
    expect(new URL(out.config.repoUrl).username).toBe('********')
  })

  it('leaves an already-masked repoUrl byte-identical', () => {
    // The server masks on read; masking its output again must be a no-op or the
    // documented get → edit → update round-trip breaks.
    const serverOutput = 'https://********@gitlab.com/team/proj.git'
    const out = redactSecrets({ config: { repoUrl: serverOutput } }) as {
      config: { repoUrl: string }
    }
    expect(out.config.repoUrl).toBe(serverOutput)
  })

  it('leaves ordinary links intact — only credential-bearing keys are reduced', () => {
    // Reducing every `url`-ish value to origin/******** would corrupt exactly
    // the values a script wants out of --json, to hide a secret they don't hold.
    const out = redactSecrets({
      downloadUrl: 'https://a2wave.test/api/artifacts/art_1/download',
      shareUrl: 'https://a2wave.test/s/shr_abc',
      callbackUrl: 'https://a2wave.test/auth/callback',
    }) as Record<string, string>

    expect(out.downloadUrl).toBe('https://a2wave.test/api/artifacts/art_1/download')
    expect(out.shareUrl).toBe('https://a2wave.test/s/shr_abc')
    expect(out.callbackUrl).toBe('https://a2wave.test/auth/callback')
  })
})
