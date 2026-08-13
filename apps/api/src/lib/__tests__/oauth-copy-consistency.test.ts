import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd(), '../..')

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

const enOauthManual = readRepoFile('apps/web/src/content/manual/en/13-idaas-oauth.md')
const zhOauthManual = readRepoFile('apps/web/src/content/manual/zh/13-idaas-oauth.md')
const oauthDeveloperDoc = readRepoFile('docs/agent/oauth-channel.md')
const bootstrapSource = readRepoFile('apps/api/src/lib/bootstrap.ts')
const oidcSource = readRepoFile('apps/api/src/lib/oidc.ts')
const ssoSchemaSource = readRepoFile('packages/shared/src/schemas/sso.ts')
const agentSchemaSource = readRepoFile('packages/shared/src/schemas/agent.ts')
const enGettingStarted = readRepoFile('apps/web/src/content/manual/en/02-getting-started.md')
const zhGettingStarted = readRepoFile('apps/web/src/content/manual/zh/02-getting-started.md')
const enRunsManual = readRepoFile('apps/web/src/content/manual/en/15-runs.md')
const zhRunsManual = readRepoFile('apps/web/src/content/manual/zh/15-runs.md')
const enLocale = JSON.parse(readRepoFile('apps/web/src/locales/en.json'))
const zhLocale = JSON.parse(readRepoFile('apps/web/src/locales/zh.json'))
const openApiSource = readRepoFile('apps/api/src/openapi.ts')
const enTriggersManual = readRepoFile('apps/web/src/content/manual/en/12-triggers.md')
const zhTriggersManual = readRepoFile('apps/web/src/content/manual/zh/12-triggers.md')
const envExample = readRepoFile('.env.example')

describe('OAuth documentation security model', () => {
  it('never tells operators to trust the audience observed in a rejected token', () => {
    const audienceGuidance = [
      enOauthManual,
      zhOauthManual,
      oauthDeveloperDoc,
      bootstrapSource,
      oidcSource,
      ssoSchemaSource,
    ].join('\n')

    expect(audienceGuidance).not.toMatch(/read its `aud`, and add that value/i)
    expect(audienceGuidance).not.toMatch(/解码 token 看 `aud`，把该值加进/)
    expect(audienceGuidance).not.toContain('the `aud` values your callers present')
    expect(audienceGuidance).not.toContain('whose `aud` points at that caller')
    expect(audienceGuidance).not.toContain('aud 指向调用方而非 a2wave')
    expect(audienceGuidance).not.toContain('channelAudiences + 隐式 clientId')

    expect(enOauthManual).toContain('request a token issued for the configured a2wave audience')
    expect(zhOauthManual).toContain('申请一枚面向已配置 a2wave 受众的 token')
    expect(oauthDeveloperDoc).toContain(
      'request a token issued for the configured a2wave resource audience',
    )
    expect(oidcSource).toContain('identify a2wave as its target resource server')
    expect(oidcSource).toContain('does not implicitly add `clientId`')
  })

  it('describes OAuth channel access as OIDC rather than generic enterprise SSO', () => {
    expect(agentSchemaSource).toContain('every OIDC-authenticated user')
    expect(agentSchemaSource).not.toContain('every enterprise SSO user')
  })

  it('states that A2A uses its own API key rather than the OIDC channel token', () => {
    expect(enGettingStarted).toContain("A2A uses the Agent's dedicated A2A API Key")
    expect(enGettingStarted).not.toContain('OAuth channel / A2A')
    expect(zhGettingStarted).toContain('A2A 使用 Agent 独立的 A2A API Key')
    expect(zhGettingStarted).not.toContain('OAuth 渠道 / A2A')
  })

  it('distinguishes Web SAML login from CLI OIDC and password login', () => {
    expect(enLocale.settings.auth.oauthEnabledDesc).toContain(
      'Web supports OIDC or SAML; CLI enterprise login requires OIDC',
    )
    expect(zhLocale.settings.auth.oauthEnabledDesc).toContain(
      'Web 支持 OIDC 或 SAML；CLI 企业登录只支持 OIDC',
    )
    expect(enOauthManual).toContain(
      'Web can use OIDC or SAML, while CLI enterprise login uses OIDC',
    )
    expect(zhOauthManual).toContain('Web 可使用 OIDC 或 SAML，CLI 企业登录则只使用 OIDC')
  })

  it('attributes caller-token identity only to the OAuth channel OIDC JWT', () => {
    expect(enRunsManual).toContain(
      "the OAuth channel can identify the user from its caller's OIDC JWT",
    )
    expect(enRunsManual).not.toContain('OAuth / enterprise SSO can identify')
    expect(zhRunsManual).toContain('OAuth 渠道可从调用者的 OIDC JWT 识别用户')
    expect(zhRunsManual).not.toContain('OAuth / 企业 SSO 可以从调用者 token 识别用户')
  })

  it('describes Settings-first audience resolution in every operator-facing source', () => {
    const englishSources = [
      openApiSource,
      oauthDeveloperDoc,
      enTriggersManual,
      enOauthManual,
      envExample,
    ]

    for (const source of englishSources) {
      expect(source).toContain('current effective OIDC channel audience configuration')
      expect(source).toContain('Settings takes precedence')
      expect(source).not.toContain('audience allowlist in A2WAVE_OIDC_CHANNEL_AUDIENCES')
    }

    expect(zhTriggersManual).toContain('当前生效的 OIDC 渠道受众配置')
    expect(zhTriggersManual).toContain('Settings 中的配置优先')
    expect(zhOauthManual).toContain('当前生效的 OIDC 渠道受众配置')
    expect(zhOauthManual).toContain('Settings 中的配置优先')
    expect(enOauthManual).toContain(
      'when the environment is the active fallback, empty = channel disabled',
    )
    expect(zhOauthManual).toContain('仅当环境变量是当前生效的回退配置时，留空才会关闭渠道')
    expect(enOauthManual).not.toContain(
      'Client ID is not added automatically; empty = channel disabled',
    )
    expect(zhOauthManual).not.toContain('Client ID 不会自动加入；留空 = 渠道关闭')
    expect(enTriggersManual).not.toContain('allowlist (`A2WAVE_OIDC_CHANNEL_AUDIENCES`)')
    expect(zhTriggersManual).not.toContain('受众白名单（`A2WAVE_OIDC_CHANNEL_AUDIENCES`）')
    expect(oauthDeveloperDoc).not.toMatch(
      /(?:allowlisted in|against) `A2WAVE_OIDC_CHANNEL_AUDIENCES`/,
    )
    expect(envExample).not.toContain(
      'OIDC is configured AND A2WAVE_OIDC_CHANNEL_AUDIENCES is non-empty',
    )
  })

  it('does not present the default a2wave login cache as an OAuth channel token', () => {
    expect(oauthDeveloperDoc).toContain(
      "Obtain a token from your caller's OIDC client for the configured a2wave resource audience",
    )
    expect(oauthDeveloperDoc).not.toContain(
      'Example: reuse the JWT cached by `a2wave login` (default cache path)',
    )
    expect(oauthDeveloperDoc).not.toContain(
      'remove the SSO token cache (default `~/.a2wave/oauth.json`)',
    )
    expect(oauthDeveloperDoc).not.toContain('jq -r .access_token ~/.a2wave/oauth.json')
  })

  it('documents the email claim requirement in both OAuth access modes', () => {
    expect(oauthDeveloperDoc).toContain('both modes require an `email` claim')
    expect(oauthDeveloperDoc).toContain('{email?, sub, tenant?}')
    expect(oauthDeveloperDoc).toContain(
      '`user_info.email` when the email is accepted as verified; otherwise `user_info` may be null',
    )
    expect(enTriggersManual).toContain('`CALLER_TOKEN_CLAIMS_INVALID`')
    expect(enTriggersManual).toContain('`specified_users` additionally requires a verified email')
    expect(zhTriggersManual).toContain('`CALLER_TOKEN_CLAIMS_INVALID`')
    expect(zhTriggersManual).toContain('`specified_users` 还要求邮箱已验证')
  })
})
