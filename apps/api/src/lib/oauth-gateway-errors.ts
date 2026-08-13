import {
  type GatewayError,
  type GatewayErrorAction,
  GatewayErrorCode,
  type GatewayErrorCode as GatewayErrorCodeValue,
  type GatewayErrorSource,
} from '@a2wave/shared'
import { providerCatalog } from '../engine/provider-catalog.js'
import { GatewayAuthErrors } from './gateway-auth-errors.js'

export type OAuthGatewayHttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 424 | 429 | 500 | 503 | 504

interface ErrorOptions {
  source: GatewayErrorSource
  action: GatewayErrorAction
  retryable: boolean
  details?: Record<string, unknown>
}

export interface ClassifiedOAuthError {
  httpStatus: OAuthGatewayHttpStatus
  error: GatewayError
}

const OIDC_RESOURCE_TOKEN_INSTRUCTION =
  "Obtain a new JWT from the caller's OIDC client for the configured a2wave resource audience"

export function createOAuthGatewayError(
  code: GatewayErrorCodeValue,
  message: string,
  options: ErrorOptions,
): { error: GatewayError } {
  return {
    error: {
      code,
      message,
      source: options.source,
      action: options.action,
      retryable: options.retryable,
      ...(options.details ? { details: options.details } : {}),
    },
  }
}

export function classifyOAuthAuthError(
  upstreamMessage: string,
  status: 401 | 403 | 503,
): ClassifiedOAuthError {
  switch (upstreamMessage) {
    case GatewayAuthErrors.IP_NOT_ALLOWED:
      return {
        httpStatus: 403,
        error: createOAuthGatewayError(
          GatewayErrorCode.IP_NOT_ALLOWED,
          'The request IP is not allowed to invoke this agent. Send the request from an allowed network or ask the agent owner to update the IP allowlist.',
          {
            source: 'caller',
            action: 'use_allowed_network',
            retryable: false,
          },
        ).error,
      }
    case GatewayAuthErrors.MISSING_AUTH_HEADER:
      return {
        httpStatus: 401,
        error: createOAuthGatewayError(
          GatewayErrorCode.AUTH_REQUIRED,
          `A JWT from the caller's OIDC client for the configured a2wave resource audience is required. Obtain one, then send it in the Authorization: Bearer <token> header.`,
          {
            source: 'caller',
            action: 'obtain_new_access_token',
            retryable: false,
          },
        ).error,
      }
    case GatewayAuthErrors.INVALID_TOKEN:
      if (status === 403) {
        return {
          httpStatus: 403,
          error: createOAuthGatewayError(
            GatewayErrorCode.CALLER_NOT_AUTHORIZED,
            'The authenticated caller is not allowed to invoke this agent. Ask the agent owner to review the access policy.',
            {
              source: 'caller',
              action: 'contact_agent_owner',
              retryable: false,
            },
          ).error,
        }
      }
      return {
        httpStatus: 401,
        error: createOAuthGatewayError(
          GatewayErrorCode.CALLER_TOKEN_INVALID,
          `The caller's access token is invalid, expired, or issued for the wrong audience. ${OIDC_RESOURCE_TOKEN_INSTRUCTION}, then retry the request.`,
          {
            source: 'caller',
            action: 'obtain_new_access_token',
            retryable: false,
          },
        ).error,
      }
    case GatewayAuthErrors.MISSING_EMAIL_CLAIM:
      return {
        httpStatus: 403,
        error: createOAuthGatewayError(
          GatewayErrorCode.CALLER_TOKEN_CLAIMS_INVALID,
          "The caller's token does not contain an email claim. Obtain a new JWT from the configured OIDC provider that includes an email claim, then retry the request.",
          {
            source: 'caller',
            action: 'obtain_new_access_token',
            retryable: false,
          },
        ).error,
      }
    case GatewayAuthErrors.MISSING_VERIFIED_EMAIL:
      return {
        httpStatus: 403,
        error: createOAuthGatewayError(
          GatewayErrorCode.CALLER_TOKEN_CLAIMS_INVALID,
          "The caller's token does not contain the verified email required by this agent's specified-users access policy. Obtain a new JWT from the configured OIDC provider with a verified email claim, then retry the request.",
          {
            source: 'caller',
            action: 'obtain_new_access_token',
            retryable: false,
          },
        ).error,
      }
    case GatewayAuthErrors.NOT_IN_ALLOWED_USERS:
      return {
        httpStatus: 403,
        error: createOAuthGatewayError(
          GatewayErrorCode.CALLER_NOT_AUTHORIZED,
          'The authenticated user is not allowed to invoke this agent. Ask the agent owner to grant access or use an authorized account.',
          {
            source: 'caller',
            action: 'contact_agent_owner',
            retryable: false,
          },
        ).error,
      }
    case GatewayAuthErrors.IDP_UNAVAILABLE:
      return {
        httpStatus: 503,
        error: createOAuthGatewayError(
          GatewayErrorCode.AUTHORIZATION_CHECK_UNAVAILABLE,
          'The identity provider could not be reached to verify the access token. Your credentials are not the problem — retry shortly; if it persists, contact the platform administrator.',
          {
            source: 'platform',
            action: 'retry_later',
            retryable: true,
          },
        ).error,
      }
    case GatewayAuthErrors.OAUTH_NOT_CONFIGURED:
      return {
        httpStatus: 503,
        error: createOAuthGatewayError(
          GatewayErrorCode.OAUTH_NOT_CONFIGURED,
          'OAuth authentication is not configured on this a2wave deployment. Contact the platform administrator before retrying.',
          {
            source: 'platform',
            action: 'contact_platform_administrator',
            retryable: false,
          },
        ).error,
      }
    default:
      if (status === 401) {
        return {
          httpStatus: 401,
          error: createOAuthGatewayError(
            GatewayErrorCode.AUTH_FAILED,
            `The caller could not be authenticated. ${OIDC_RESOURCE_TOKEN_INSTRUCTION}, then retry the request.`,
            {
              source: 'caller',
              action: 'obtain_new_access_token',
              retryable: false,
            },
          ).error,
        }
      }
      if (status === 403) {
        return {
          httpStatus: 403,
          error: createOAuthGatewayError(
            GatewayErrorCode.CALLER_NOT_AUTHORIZED,
            'The authenticated caller is not allowed to invoke this agent. Ask the agent owner to review the access policy.',
            {
              source: 'caller',
              action: 'contact_agent_owner',
              retryable: false,
            },
          ).error,
        }
      }
      return {
        httpStatus: 503,
        error: createOAuthGatewayError(
          GatewayErrorCode.AUTHORIZATION_CHECK_UNAVAILABLE,
          'The caller authorization check is temporarily unavailable. Retry later; if the problem persists, contact the platform administrator.',
          {
            source: 'platform',
            action: 'retry_later',
            retryable: true,
          },
        ).error,
      }
  }
}

/**
 * Human-readable Provider name for caller-facing messages.
 *
 * Sourced from the Provider manifest — the single authority for a Provider's
 * display name — so a newly registered kind is named here automatically. A
 * hand-maintained switch had silently gone stale for opencode/qoder/trae/
 * copilot, telling OAuth callers to re-authenticate a "configured provider"
 * instead of naming the one that actually failed; routing through the
 * prompt-rendering label map would only have relocated that staleness, since
 * that map is hand-maintained too (and drifts: it says "Cursor Agent" where the
 * Provider is "Cursor CLI").
 */
function providerName(engineType: string | undefined): string {
  if (!engineType) return 'configured provider'
  // `get` parses against PROVIDER_KINDS and returns undefined for anything that
  // is not a registered Provider — including the legacy `llm` / `script` Agent
  // types, which have no login to re-authenticate — so unknown inputs keep the
  // neutral phrase instead of leaking an internal id.
  return providerCatalog.get(engineType)?.manifest.displayName ?? 'configured provider'
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error ?? '')
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function executionDetails(runId: string, engineType: string | undefined): Record<string, unknown> {
  return {
    runId,
    ...(engineType ? { provider: engineType } : {}),
  }
}

function classifiedExecutionError(
  httpStatus: OAuthGatewayHttpStatus,
  code: GatewayErrorCodeValue,
  message: string,
  options: ErrorOptions,
): ClassifiedOAuthError {
  return {
    httpStatus,
    error: createOAuthGatewayError(code, message, options).error,
  }
}

export function classifyOAuthExecutionError(
  error: unknown,
  context: { runId: string; engineType?: string },
): ClassifiedOAuthError {
  const raw = errorText(error)
  const lower = raw.toLowerCase()
  const upstreamCode = errorCode(error)
  const effectiveEngineType = lower.includes('access token could not be refreshed')
    ? 'codex'
    : context.engineType
  const name = providerName(effectiveEngineType)
  const details = executionDetails(context.runId, effectiveEngineType)

  if (
    upstreamCode === 'SERVER_RESTART_DURING_EXEC' ||
    upstreamCode === 'PENDING_ORPHAN_ON_STARTUP' ||
    lower.includes('server restart')
  ) {
    return classifiedExecutionError(
      503,
      GatewayErrorCode.EXECUTION_INTERRUPTED,
      'The run was interrupted by a server restart. Submit the request again.',
      { source: 'platform', action: 'retry', retryable: true, details },
    )
  }

  if (upstreamCode === 'DANGLING_RUN_ON_STARTUP') {
    return classifiedExecutionError(
      424,
      GatewayErrorCode.AGENT_CONFIGURATION_ERROR,
      'The run could not resume because its agent configuration is no longer available. Ask the agent owner to verify the agent, then submit a new request.',
      { source: 'agent', action: 'contact_agent_owner', retryable: false, details },
    )
  }

  if (
    lower.includes('scm source') ||
    lower.includes('worktree') ||
    lower.includes('workspace unavailable') ||
    lower.includes('workspace is already occupied') ||
    lower.includes('failed to create workspace') ||
    lower.includes('invalid workspace name') ||
    lower.includes('failed to prepare workspace') ||
    ((lower.includes('git') || lower.includes('repository')) &&
      (lower.includes('authentication failed') ||
        lower.includes('permission denied') ||
        lower.includes('unauthorized')))
  ) {
    return classifiedExecutionError(
      424,
      GatewayErrorCode.AGENT_WORKSPACE_UNAVAILABLE,
      "The agent's source workspace is not ready. Ask the agent owner to sync or repair the configured source workspace, then retry.",
      { source: 'agent', action: 'contact_agent_owner', retryable: false, details },
    )
  }

  if (
    lower.includes('no engine registered') ||
    lower.includes('model not found') ||
    lower.includes('invalid model') ||
    lower.includes('unknown model') ||
    lower.includes('unsupported model') ||
    // Kimi's signature failures when the host is signed out or has no provider
    // configured. Both are permanent configuration faults, but neither matched
    // the model strings above nor the codex|cursor|claude reauth regex, so they
    // fell through to a retryable 500 and told callers to keep retrying.
    lower.includes('no model configured') ||
    lower.includes('no models available') ||
    lower.includes('no providers configured') ||
    lower.includes('tools are not supported') ||
    lower.includes('tool calling is not supported') ||
    lower.includes('does not support tools') ||
    lower.includes('command not found') ||
    lower.includes('not executable') ||
    lower.includes('gateway_') ||
    lower.includes('gateway access requires') ||
    (lower.includes('model') && lower.includes('unauthorized')) ||
    (lower.includes('mcp') &&
      (lower.includes('not logged in') ||
        lower.includes('unauthorized') ||
        lower.includes('authentication failed') ||
        lower.includes('permission denied')))
  ) {
    return classifiedExecutionError(
      424,
      GatewayErrorCode.AGENT_CONFIGURATION_ERROR,
      "The agent's execution provider or integration is not configured correctly. Ask the agent owner to review the provider, model, MCP, and gateway settings.",
      { source: 'agent', action: 'contact_agent_owner', retryable: false, details },
    )
  }

  if (
    lower.includes('access token could not be refreshed') ||
    lower.includes('refresh token was revoked') ||
    lower.includes('refresh token has expired') ||
    lower.includes('refresh token was already used') ||
    lower.includes('please run codex login') ||
    lower.includes('please log out and sign in again') ||
    /^not logged in[.!]?$/.test(lower) ||
    lower.startsWith('user email not logged in') ||
    /(?:codex|cursor(?: agent)?|claude(?: code)?).*not logged in/.test(lower)
  ) {
    return classifiedExecutionError(
      424,
      GatewayErrorCode.PROVIDER_REAUTH_REQUIRED,
      `The agent's ${name} login has expired or been revoked. Ask the agent owner to sign in to ${name} again, then retry the request.`,
      { source: 'provider', action: 'contact_agent_owner', retryable: false, details },
    )
  }

  if (
    lower.includes('usage limit') ||
    lower.includes('session limit') ||
    lower.includes('quota') ||
    lower.includes('credit balance')
  ) {
    return classifiedExecutionError(
      424,
      GatewayErrorCode.PROVIDER_QUOTA_EXCEEDED,
      `The agent's ${name} account has reached a usage or quota limit. Ask the agent owner to check the provider account limits before retrying.`,
      { source: 'provider', action: 'contact_agent_owner', retryable: false, details },
    )
  }

  if (
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    /(^|\D)429(\D|$)/.test(lower)
  ) {
    return classifiedExecutionError(
      503,
      GatewayErrorCode.PROVIDER_RATE_LIMITED,
      `${name} temporarily rate-limited this agent. Retry later; if it continues, ask the agent owner to review provider limits.`,
      { source: 'provider', action: 'retry_later', retryable: true, details },
    )
  }

  if (
    lower.includes('context window') ||
    lower.includes('prompt is too long') ||
    lower.includes('input is too long') ||
    lower.includes('maximum context length')
  ) {
    return classifiedExecutionError(
      422,
      GatewayErrorCode.CONTEXT_LIMIT_EXCEEDED,
      'The request exceeds the agent model context limit. Shorten the message or start a new session, then retry.',
      { source: 'caller', action: 'fix_request', retryable: false, details },
    )
  }

  if (
    lower.includes('content policy') ||
    lower.includes('cyber policy') ||
    /\bsafety\b/.test(lower)
  ) {
    return classifiedExecutionError(
      422,
      GatewayErrorCode.REQUEST_REJECTED,
      'The provider rejected the request under its usage or safety policy. Revise the request before retrying.',
      { source: 'caller', action: 'fix_request', retryable: false, details },
    )
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return classifiedExecutionError(
      504,
      GatewayErrorCode.EXECUTION_TIMEOUT,
      'The agent did not finish before the execution timeout. Retry the request; if it continues, ask the agent owner to review the timeout setting.',
      { source: 'agent', action: 'retry', retryable: true, details },
    )
  }

  if (
    lower.includes('server overloaded') ||
    lower.includes('service unavailable') ||
    lower.includes('stream disconnected') ||
    lower.includes('connection failed') ||
    lower.includes('network error') ||
    /(^|\D)50[23](\D|$)/.test(lower)
  ) {
    return classifiedExecutionError(
      503,
      GatewayErrorCode.PROVIDER_UNAVAILABLE,
      `${name} is temporarily unavailable. Retry later; if it continues, contact the agent owner.`,
      { source: 'provider', action: 'retry_later', retryable: true, details },
    )
  }

  if (
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes('no api key found') ||
    lower.includes('authentication_error') ||
    /^authentication failed[.!]?$/.test(lower) ||
    /^(?:401 unauthorized|unauthorized)[.!]?$/.test(lower) ||
    /(?:codex|cursor-agent|claude): unauthorized/.test(lower)
  ) {
    return classifiedExecutionError(
      424,
      GatewayErrorCode.PROVIDER_AUTH_FAILED,
      `The agent's ${name} credentials were rejected. Ask the agent owner to update or re-authenticate the configured provider, then retry.`,
      { source: 'provider', action: 'contact_agent_owner', retryable: false, details },
    )
  }

  return classifiedExecutionError(
    500,
    GatewayErrorCode.EXECUTION_ERROR,
    'The agent could not complete the request. Retry once; if it fails again, give the runId to the agent owner for investigation.',
    { source: 'agent', action: 'retry', retryable: true, details },
  )
}

export function classifyOAuthWorkspaceError(context: {
  runId: string
  busy: boolean
}): ClassifiedOAuthError {
  return classifiedExecutionError(
    context.busy ? 409 : 424,
    GatewayErrorCode.AGENT_WORKSPACE_UNAVAILABLE,
    context.busy
      ? "The agent's workspace is currently in use or has uncommitted changes. Retry after the active workspace operation finishes."
      : "The agent's workspace could not be prepared. Ask the agent owner to check the configured source workspace, then retry.",
    {
      source: 'agent',
      action: context.busy ? 'retry_later' : 'contact_agent_owner',
      retryable: context.busy,
      details: { runId: context.runId },
    },
  )
}
