import type { OpenAPIV3 } from './types/openapi.js'

const session: OpenAPIV3.SecurityRequirementObject[] = [{ sessionCookie: [] }, { userSession: [] }]
const string: OpenAPIV3.SchemaObject = { type: 'string' }
const date: OpenAPIV3.SchemaObject = { type: 'string', format: 'date-time' }
const parameter = (name: string): OpenAPIV3.ParameterObject => ({
  name,
  in: 'path',
  required: true,
  schema: string,
})
const body = (
  properties: Record<string, OpenAPIV3.SchemaObject>,
  required: string[] = [],
): OpenAPIV3.RequestBodyObject => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties, required } } },
})
const response = (data: OpenAPIV3.SchemaObject, description: string): OpenAPIV3.ResponseObject => ({
  description,
  content: {
    'application/json': { schema: { type: 'object', required: ['data'], properties: { data } } },
  },
})
const account: OpenAPIV3.SchemaObject = {
  type: 'object',
  description: 'Shared account metadata; credentials are never returned.',
  properties: {
    id: string,
    providerId: string,
    label: string,
    email: { type: 'string', nullable: true },
    subject: string,
    clientId: string,
    createdByUserId: { type: 'string', nullable: true },
    canManage: { type: 'boolean' },
    status: { type: 'string', enum: ['ready', 'expired', 'reauth_required'] },
    expiresAt: date,
    createdAt: date,
    updatedAt: date,
  },
}
const errors = {
  '400': { description: 'Invalid input or unsupported Provider.' },
  '401': { description: 'Missing, expired, consumed, or revoked authorization.' },
  '403': { description: 'Only the account creator or an administrator may manage it.' },
  '404': { description: 'Provider, account, or login does not exist.' },
  '409': {
    description:
      'Account is referenced by an Agent or an authorization operation is already in progress.',
  },
  '502': {
    description: 'Upstream authorization failed. No token or upstream response body is returned.',
  },
}

export const providerOauthPaths: Record<string, OpenAPIV3.PathItemObject> = {
  '/providers/{id}/oauth-accounts': {
    get: {
      operationId: 'listProviderOauthAccounts',
      summary: 'List shared ChatGPT accounts',
      tags: ['Providers'],
      security: session,
      parameters: [parameter('id')],
      responses: {
        '200': response({ type: 'array', items: account }, 'Accounts that Agent editors may bind.'),
        ...errors,
      },
    },
  },
  '/providers/{id}/oauth-accounts/login': {
    post: {
      operationId: 'createProviderOauthLogin',
      summary: 'Authorize a new shared account or reconnect an existing one',
      description:
        'Any authenticated colleague may add an account. Reconnection requires creator/admin. Pass the short-lived loginToken only to the local a2wave CLI hidden prompt; never place it in argv or a URL.',
      tags: ['Providers'],
      security: session,
      parameters: [parameter('id')],
      requestBody: body({ accountId: string, label: { type: 'string', maxLength: 100 } }),
      responses: {
        '201': response(
          {
            type: 'object',
            required: ['loginId', 'loginToken', 'expiresAt'],
            properties: { loginId: string, loginToken: string, expiresAt: date },
          },
          'One-use authorization capability, valid for 15 minutes.',
        ),
        ...errors,
      },
    },
  },
  '/providers/{id}/oauth-accounts/logins/{loginId}': {
    get: {
      operationId: 'getProviderOauthLogin',
      summary: 'Read authorization status (initiator/admin)',
      tags: ['Providers'],
      security: session,
      parameters: [parameter('id'), parameter('loginId')],
      responses: {
        '200': response(
          {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['pending', 'started', 'completed', 'failed', 'expired'],
              },
              accountId: string,
              error: string,
            },
          },
          'Status only; no authorization URL or credentials.',
        ),
        ...errors,
      },
    },
  },
  '/providers/{id}/oauth-accounts/{accountId}': {
    patch: {
      operationId: 'renameProviderOauthAccount',
      summary: 'Rename an account (creator/admin)',
      tags: ['Providers'],
      security: session,
      parameters: [parameter('id'), parameter('accountId')],
      requestBody: body({ label: { type: 'string', minLength: 1, maxLength: 100 } }, ['label']),
      responses: { '200': response(account, 'Updated account metadata.'), ...errors },
    },
    delete: {
      operationId: 'deleteProviderOauthAccount',
      summary: 'Revoke and remove an unbound account (creator/admin)',
      description:
        'Refuses accounts referenced by Agents. Confirms remote session revocation before deleting local credentials; on a network failure the record is retained for retry.',
      tags: ['Providers'],
      security: session,
      parameters: [parameter('id'), parameter('accountId')],
      responses: {
        '200': response(
          { type: 'object', properties: { id: string } },
          'Session revoked and local account removed.',
        ),
        ...errors,
      },
    },
  },
  '/provider-oauth-logins/{loginId}/start': {
    post: {
      operationId: 'startProviderOauthLogin',
      summary: 'Start browser authorization using the short-lived CLI login capability',
      tags: ['Providers'],
      security: [{ providerOauthLogin: [] }],
      parameters: [parameter('loginId')],
      requestBody: body(
        {
          redirectUri: {
            type: 'string',
            description: 'Only http://127.0.0.1:<port>/auth/callback is accepted.',
          },
        },
        ['redirectUri'],
      ),
      responses: {
        '200': response(
          { type: 'object', properties: { authorizationUrl: string } },
          'Open in the system browser. The URL may contain a retained ID-token hint and must not be logged.',
        ),
        ...errors,
      },
    },
  },
  '/provider-oauth-logins/{loginId}/complete': {
    post: {
      operationId: 'completeProviderOauthLogin',
      summary: 'Consume a callback once and store validated credentials',
      tags: ['Providers'],
      security: [{ providerOauthLogin: [] }],
      parameters: [parameter('loginId')],
      requestBody: body({ code: string, state: string, clientId: string, error: string }, [
        'state',
      ]),
      responses: {
        '200': response(
          { type: 'object', properties: { accountId: string } },
          'Validated account reference; tokens remain on the server.',
        ),
        ...errors,
      },
    },
  },
}
