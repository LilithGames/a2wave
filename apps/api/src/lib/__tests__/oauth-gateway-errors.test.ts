import { PROVIDER_KINDS } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { providerCatalog } from '../../engine/provider-catalog.js'
import { GatewayAuthErrors } from '../gateway-auth-errors.js'
import {
  classifyOAuthAuthError,
  classifyOAuthExecutionError,
  classifyOAuthWorkspaceError,
} from '../oauth-gateway-errors.js'

describe('OAuth gateway caller-facing error classification', () => {
  it.each([
    [
      GatewayAuthErrors.MISSING_AUTH_HEADER,
      401,
      'AUTH_REQUIRED',
      'caller',
      'obtain_new_access_token',
    ],
    [
      GatewayAuthErrors.INVALID_TOKEN,
      401,
      'CALLER_TOKEN_INVALID',
      'caller',
      'obtain_new_access_token',
    ],
    [
      GatewayAuthErrors.MISSING_EMAIL_CLAIM,
      403,
      'CALLER_TOKEN_CLAIMS_INVALID',
      'caller',
      'obtain_new_access_token',
    ],
    [
      GatewayAuthErrors.MISSING_VERIFIED_EMAIL,
      403,
      'CALLER_TOKEN_CLAIMS_INVALID',
      'caller',
      'obtain_new_access_token',
    ],
    // An IdP outage is a platform problem the caller can retry, not a credential failure.
    [
      GatewayAuthErrors.IDP_UNAVAILABLE,
      503,
      'AUTHORIZATION_CHECK_UNAVAILABLE',
      'platform',
      'retry_later',
    ],
    [
      GatewayAuthErrors.NOT_IN_ALLOWED_USERS,
      403,
      'CALLER_NOT_AUTHORIZED',
      'caller',
      'contact_agent_owner',
    ],
    [
      GatewayAuthErrors.OAUTH_NOT_CONFIGURED,
      503,
      'OAUTH_NOT_CONFIGURED',
      'platform',
      'contact_platform_administrator',
    ],
    [GatewayAuthErrors.IP_NOT_ALLOWED, 403, 'IP_NOT_ALLOWED', 'caller', 'use_allowed_network'],
  ] as const)(
    'maps %s to an unambiguous public error',
    (upstream, status, code, source, action) => {
      const result = classifyOAuthAuthError(upstream, status)

      expect(result.httpStatus).toBe(status)
      expect(result.error).toMatchObject({ code, source, action })
      expect(result.error.message.length).toBeGreaterThan(20)
    },
  )

  it('never turns an upstream 403 into a caller-token 401', async () => {
    const result = classifyOAuthAuthError('Invalid token', 403)

    expect(result).toMatchObject({
      httpStatus: 403,
      error: {
        code: 'CALLER_NOT_AUTHORIZED',
        source: 'caller',
        action: 'contact_agent_owner',
      },
    })
  })

  it.each([
    [
      GatewayAuthErrors.MISSING_AUTH_HEADER,
      "A JWT from the caller's OIDC client for the configured a2wave resource audience is required. Obtain one, then send it in the Authorization: Bearer <token> header.",
    ],
    [
      GatewayAuthErrors.INVALID_TOKEN,
      "The caller's access token is invalid, expired, or issued for the wrong audience. Obtain a new JWT from the caller's OIDC client for the configured a2wave resource audience, then retry the request.",
    ],
    [
      'Unknown authentication failure',
      "The caller could not be authenticated. Obtain a new JWT from the caller's OIDC client for the configured a2wave resource audience, then retry the request.",
    ],
  ])('directs 401 callers to the a2wave resource audience for %s', (upstream, message) => {
    const result = classifyOAuthAuthError(upstream, 401)

    expect(result.error.message).toBe(message)
    expect(result.error.message).not.toContain('Sign in')
    expect(result.error.action).toBe('obtain_new_access_token')
  })

  it('requests an OIDC JWT with an email claim when email is absent in either access mode', () => {
    const result = classifyOAuthAuthError(GatewayAuthErrors.MISSING_EMAIL_CLAIM, 403)

    expect(result.error.message).toBe(
      "The caller's token does not contain an email claim. Obtain a new JWT from the configured OIDC provider that includes an email claim, then retry the request.",
    )
    expect(result.error.message).not.toContain('enterprise SSO')
    expect(result.error.message).not.toContain('required by this agent')
    expect(result.error.action).toBe('obtain_new_access_token')
  })

  it('requests a verified email claim for specified-users access', () => {
    const result = classifyOAuthAuthError(GatewayAuthErrors.MISSING_VERIFIED_EMAIL, 403)

    expect(result.error.message).toBe(
      "The caller's token does not contain the verified email required by this agent's specified-users access policy. Obtain a new JWT from the configured OIDC provider with a verified email claim, then retry the request.",
    )
    expect(result.error.action).toBe('obtain_new_access_token')
  })

  it.each([
    [
      'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
      'PROVIDER_REAUTH_REQUIRED',
      424,
      false,
    ],
    ['401 Unauthorized: invalid API key', 'PROVIDER_AUTH_FAILED', 424, false],
    ['429 Too many requests', 'PROVIDER_RATE_LIMITED', 503, true],
    ['usage limit reached for this account', 'PROVIDER_QUOTA_EXCEEDED', 424, false],
    ['response stream disconnected', 'PROVIDER_UNAVAILABLE', 503, true],
    ['Task execution timeout (30s)', 'EXECUTION_TIMEOUT', 504, true],
    ['maximum context length exceeded', 'CONTEXT_LIMIT_EXCEEDED', 422, false],
    ['request rejected by content policy', 'REQUEST_REJECTED', 422, false],
    ['GATEWAY_NOT_CONFIGURED: signer disabled', 'AGENT_CONFIGURATION_ERROR', 424, false],
  ] as const)('classifies execution error %s', (raw, code, status, retryable) => {
    const result = classifyOAuthExecutionError(raw, {
      runId: 'run_test',
      engineType: 'codex',
    })

    expect(result).toMatchObject({
      httpStatus: status,
      error: { code, retryable, details: { runId: 'run_test', provider: 'codex' } },
    })
  })

  it('does not leak an unknown internal error to an OAuth caller', async () => {
    const result = classifyOAuthExecutionError(
      'spawn /private/secret/path/codex ENOENT password=secret',
      { runId: 'run_test', engineType: 'codex' },
    )

    expect(result.error.code).toBe('EXECUTION_ERROR')
    expect(result.error.message).not.toContain('/private/secret/path')
    expect(result.error.message).not.toContain('password=secret')
    expect(result.error.message).toContain('runId')
  })

  it.each([
    ['401 Unauthorized: tools are not supported by this model', 'AGENT_CONFIGURATION_ERROR', 424],
    ['MCP server github is not logged in', 'AGENT_CONFIGURATION_ERROR', 424],
    ['usage limit reached (HTTP 401)', 'PROVIDER_QUOTA_EXCEEDED', 424],
    ['Worktree git authentication failed', 'AGENT_WORKSPACE_UNAVAILABLE', 424],
    ['provider diagnostic 40100', 'EXECUTION_ERROR', 500],
  ] as const)('does not misclassify overlapping execution error %s', (raw, code, status) => {
    const result = classifyOAuthExecutionError(raw, {
      runId: 'run_overlap',
      engineType: 'codex',
    })

    expect(result).toMatchObject({ httpStatus: status, error: { code } })
  })

  it.each(['llm', 'script'] as const)(
    'does not present the non-CLI agent type %s as a provider name',
    (engineType) => {
      // `llm` / `script` are legacy Agent types, not CLI Providers with a login;
      // "The agent's LLM login has expired" would be nonsense to a caller.
      const result = classifyOAuthExecutionError('Not logged in.', {
        runId: 'run_name',
        engineType,
      })

      expect(result.error.message).toContain('configured provider')
    },
  )

  it('takes the display name from the Provider manifest, not a parallel map', async () => {
    // The authoritative name is the registered Provider's manifest. Sourcing it
    // from the prompt-rendering label map only moved the staleness: a new kind
    // that forgot to update ENGINE_TYPE_LABELS would silently regress to
    // "configured provider" again, with no test or gate to catch it. Assert
    // against the catalog so the two can never drift.
    for (const kind of PROVIDER_KINDS) {
      const expected = providerCatalog.getOrThrow(kind).manifest.displayName
      const result = classifyOAuthExecutionError('Not logged in.', {
        runId: 'run_manifest',
        engineType: kind,
      })

      expect(result.error.message, `kind ${kind}`).toContain(expected)
      expect(result.error.message, `kind ${kind}`).not.toContain('configured provider')
    }
  })

  it('falls back to a neutral label for an unknown engine type', async () => {
    const result = classifyOAuthExecutionError('Not logged in.', {
      runId: 'run_name',
      engineType: 'some-future-engine',
    })

    expect(result.error.message).toContain('configured provider')
  })

  it.each([
    'error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in.',
    'No providers configured',
  ])('treats the Kimi config failure %# as a non-retryable agent config error', (raw) => {
    // A signed-out / unconfigured Kimi host fails permanently, but neither
    // string matched the config-error branch (which only knew `model not
    // found` / `invalid model` / ...) nor the reauth regex (codex|cursor|
    // claude only), so it fell through to a retryable 500 — telling a
    // spec-compliant caller to retry a permanent misconfiguration forever.
    const result = classifyOAuthExecutionError(raw, { runId: 'run_kimi', engineType: 'kimi' })

    expect(result.error.retryable).toBe(false)
    expect(result.httpStatus).toBe(424)
    expect(result.error.code).toBe('AGENT_CONFIGURATION_ERROR')
  })

  it('classifies Pi missing-model and missing-key failures without blaming the caller token', async () => {
    const noModels = classifyOAuthExecutionError(
      'No models available. Configure an API key or run /login.',
      { runId: 'run_pi_models', engineType: 'pi' },
    )
    const noKey = classifyOAuthExecutionError('No API key found for provider openai', {
      runId: 'run_pi_key',
      engineType: 'pi',
    })

    expect(noModels).toMatchObject({
      httpStatus: 424,
      error: { code: 'AGENT_CONFIGURATION_ERROR', source: 'agent', retryable: false },
    })
    expect(noKey).toMatchObject({
      httpStatus: 424,
      error: { code: 'PROVIDER_AUTH_FAILED', source: 'provider', retryable: false },
    })
    expect(noKey.error.message).toContain('Pi CLI')
  })

  it('normalizes structured restart failures returned by async polling', async () => {
    const result = classifyOAuthExecutionError(
      {
        // Deliberately free of the phrase "server restart": classification must be
        // driven by `code`, not by the message fallback branch, or a regression in
        // the code branch would still pass here.
        code: 'SERVER_RESTART_DURING_EXEC',
        message: 'Interrupted mid-run; safe to retry',
        retryable: true,
      },
      { runId: 'run_restart' },
    )

    expect(result.error).toMatchObject({
      code: 'EXECUTION_INTERRUPTED',
      source: 'platform',
      action: 'retry',
      retryable: true,
      details: { runId: 'run_restart' },
    })
  })

  it.each([
    'SCM source not synced',
    "SCM source 'scm_missing' not found",
    'Worktree requires SCM workspace type with a linked code source',
    'Failed to create workspace: branch is locked',
  ])('maps queued workspace failure %s without exposing its raw detail', (raw) => {
    const result = classifyOAuthExecutionError(raw, { runId: 'run_workspace' })

    expect(result.error).toMatchObject({
      code: 'AGENT_WORKSPACE_UNAVAILABLE',
      source: 'agent',
      action: 'contact_agent_owner',
      retryable: false,
      details: { runId: 'run_workspace' },
    })
    expect(result.error.message).not.toContain('scm_missing')
  })

  it('maps a dangling recovered run to an agent configuration action', async () => {
    const result = classifyOAuthExecutionError(
      {
        code: 'DANGLING_RUN_ON_STARTUP',
        message: 'The associated Agent no longer exists; archived during startup recovery',
        retryable: false,
      },
      { runId: 'run_dangling' },
    )

    expect(result.error).toMatchObject({
      code: 'AGENT_CONFIGURATION_ERROR',
      source: 'agent',
      action: 'contact_agent_owner',
      retryable: false,
    })
  })

  it('does not trust or expose a structured error message during OAuth run projection', async () => {
    const result = classifyOAuthExecutionError(
      {
        code: 'PROVIDER_REAUTH_REQUIRED',
        message: 'private path /srv/secret and token=abc',
        source: 'provider',
        action: 'contact_agent_owner',
        retryable: false,
        details: { provider: 'codex' },
      },
      { runId: 'run_public', engineType: 'cursor' },
    )

    expect(result).toMatchObject({
      httpStatus: 500,
      error: {
        code: 'EXECUTION_ERROR',
        source: 'agent',
        action: 'retry',
        details: { runId: 'run_public', provider: 'cursor' },
      },
    })
    expect(result.error.message).not.toContain('/srv/secret')
    expect(result.error.message).not.toContain('token=abc')
  })

  it('separates a busy workspace from a broken workspace configuration', async () => {
    expect(classifyOAuthWorkspaceError({ runId: 'run_1', busy: true })).toMatchObject({
      httpStatus: 409,
      error: { code: 'AGENT_WORKSPACE_UNAVAILABLE', action: 'retry_later', retryable: true },
    })
    expect(classifyOAuthWorkspaceError({ runId: 'run_2', busy: false })).toMatchObject({
      httpStatus: 424,
      error: {
        code: 'AGENT_WORKSPACE_UNAVAILABLE',
        action: 'contact_agent_owner',
        retryable: false,
      },
    })
  })
})
