import { GatewayErrorCode } from '@a2wave/shared'
import type { OpenAPIV3 } from './types/openapi.js'

const gatewayErrorProperties: NonNullable<OpenAPIV3.SchemaObject['properties']> = {
  code: {
    type: 'string',
    enum: Object.values(GatewayErrorCode),
  },
  message: { type: 'string' },
  source: { type: 'string', enum: ['caller', 'agent', 'provider', 'platform'] },
  action: {
    type: 'string',
    enum: [
      'fix_request',
      'obtain_new_access_token',
      'use_allowed_network',
      'wait_for_current_run',
      'retry',
      'retry_later',
      'contact_agent_owner',
      'contact_platform_administrator',
    ],
  },
  retryable: { type: 'boolean' },
  details: {},
}

function createGatewayErrorSchema(required: string[]): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required,
        properties: gatewayErrorProperties,
      },
    },
  }
}

const gatewayErrorSchema = createGatewayErrorSchema(['code', 'message'])
const oauthGatewayErrorSchema = createGatewayErrorSchema([
  'code',
  'message',
  'source',
  'action',
  'retryable',
])

const gatewayRunStatusResponseSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'queued'],
        },
        result: {
          type: 'object',
          nullable: true,
          description:
            'Legacy Gateway run result. Failed runs may contain a string error or the newer structured error object.',
          properties: {
            error: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/GatewayError/properties/error' },
              ],
            },
          },
          additionalProperties: true,
        },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
}

const oauthRunStatusResponseSchema: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'queued'],
        },
        result: {
          type: 'object',
          nullable: true,
          description:
            'OAuth run result. Failed runs expose only a caller-safe structured error; raw provider messages are not returned.',
          properties: {
            error: { $ref: '#/components/schemas/OAuthGatewayError/properties/error' },
          },
          additionalProperties: true,
        },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
}

function errorResponse(
  description: string,
  schema: OpenAPIV3.SchemaObject = gatewayErrorSchema,
): OpenAPIV3.ResponseObject {
  return {
    description,
    content: { 'application/json': { schema } },
  }
}

function oauthErrorResponse(description: string): OpenAPIV3.ResponseObject {
  return errorResponse(description, oauthGatewayErrorSchema)
}

export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'a2wave Invocation API',
    version: '1.1.0',
    description:
      'API-key Gateway and enterprise OIDC OAuth APIs for invoking published agents, querying run results, and cancelling runs. ' +
      'HTTP 401 on OAuth paths always refers to the caller JWT issued by the enterprise OIDC provider. Agent provider credential failures use PROVIDER_* codes and never HTTP 401.',
  },
  servers: [{ url: '/api', description: 'a2wave API base path' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: "Agent's API key passed as a Bearer token.",
      },
      ssoJwt: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Caller JWT issued by your enterprise OIDC provider (typically an access token), verified against the IdP JWKS and the current effective OIDC channel audience configuration. Settings takes precedence; the environment variable is only a fallback when no valid Settings configuration exists. SAML login mints an a2wave session for the regular authenticated APIs, but no token usable on this channel. The token must carry an email claim. This is independent from the agent execution provider credentials.',
      },
    },
    parameters: {
      agentId: {
        name: 'agentId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Agent ID (prefixed with `agt_`).',
      },
      runId: {
        name: 'runId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Run ID (prefixed with `run_`).',
      },
      xRequestId: {
        name: 'X-Request-ID',
        in: 'header',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description:
          'Optional request tracing ID. If omitted the server generates one and returns it in the response header.',
      },
    },
    schemas: {
      GatewayError: gatewayErrorSchema,
      OAuthGatewayError: oauthGatewayErrorSchema,
      InvokeRequest: {
        type: 'object',
        required: ['message'],
        properties: {
          message: {
            type: 'string',
            minLength: 1,
            description: 'The intent / prompt to send to the agent.',
          },
          context: {
            type: 'object',
            additionalProperties: true,
            description:
              'Additional context object injected into the system prompt via {{context}} template variable (rendered as JSON string).',
          },
          stream: {
            type: 'boolean',
            default: false,
            description: 'Enable SSE streaming for real-time updates.',
          },
          async: {
            type: 'boolean',
            default: true,
            description: 'Run asynchronously. Set false for synchronous JSON or SSE responses.',
          },
          attachments: {
            type: 'array',
            description:
              'Image/document attachments (max 10). Two-step upload: POST /{agentId}/attachments first to get a token, then pass the refs here.',
            items: { $ref: '#/components/schemas/AttachmentRef' },
          },
        },
      },
      AttachmentRef: {
        type: 'object',
        required: ['token', 'name', 'mimeType'],
        properties: {
          token: { type: 'string', description: 'Opaque staging token from the upload endpoint.' },
          name: { type: 'string' },
          mimeType: { type: 'string' },
          size: { type: 'integer' },
        },
      },
      AttachmentUploadResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              name: { type: 'string' },
              mimeType: { type: 'string' },
              size: { type: 'integer' },
            },
          },
        },
      },
      OAuthInvokeRequest: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 100000 },
          context: { type: 'object', additionalProperties: true },
          sessionId: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            pattern: '^[A-Za-z0-9._:-]+$',
            description: 'Caller-chosen session key, isolated by agent and OIDC caller identity.',
          },
          resetSession: { type: 'boolean', default: false },
          stream: {
            type: 'boolean',
            default: false,
            description: 'When true, takes precedence over async and returns SSE.',
          },
          async: { type: 'boolean', default: true },
        },
      },
      SyncInvokeResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              reply: { type: 'string', description: 'Agent response text.' },
              runId: { type: 'string' },
              durationMs: { type: 'number', description: 'Execution time in milliseconds.' },
            },
          },
        },
      },
      AsyncInvokeResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              runId: { type: 'string', description: 'Use this ID to poll the run status.' },
            },
          },
        },
      },
      GatewayRunStatusResponse: gatewayRunStatusResponseSchema,
      OAuthRunStatusResponse: oauthRunStatusResponseSchema,
      CancelRunResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              runId: { type: 'string' },
              status: { type: 'string', enum: ['cancelled'] },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/gateway/{agentId}/attachments': {
      post: {
        operationId: 'uploadAttachment',
        summary: 'Upload an attachment',
        description:
          'Two-step attachment upload (step 1). Upload a single file (multipart/form-data, field name `file`) and receive an opaque `token`; then pass `{token,name,mimeType}` in the invoke body `attachments` array. Size/type limits come from the admin-configurable attachments settings (default 10MB, images + common docs).',
        tags: ['Invoke'],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Uploaded; returns the staging token.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AttachmentUploadResponse' },
              },
            },
          },
          400: { description: 'No file / invalid type.' },
          413: { description: 'File too large.' },
        },
      },
    },
    '/gateway/{agentId}/invoke': {
      post: {
        operationId: 'invokeAgent',
        summary: 'Invoke an agent',
        description:
          'Send a message to a published agent.\n\n' +
          '- **Async** (default): returns `202` with a `runId` for polling.\n' +
          '- **Sync** (`async: false`): blocks until the agent replies.\n' +
          '- **Stream** (`stream: true, async: false`): returns an SSE stream with `update`, `log`, `done`, and `error` events.',
        tags: ['Invoke'],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/InvokeRequest' },
              examples: {
                sync: {
                  summary: 'Synchronous invocation',
                  value: { message: 'Summarize the latest PR changes' },
                },
                async: {
                  summary: 'Asynchronous invocation',
                  value: { message: 'Refactor the auth module', async: true },
                },
                stream: {
                  summary: 'Streaming invocation',
                  value: { message: 'Generate a migration script', stream: true },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Synchronous invocation succeeded.',
            headers: {
              'X-Request-ID': { schema: { type: 'string' }, description: 'Request tracing ID.' },
            },
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SyncInvokeResponse' } },
            },
          },
          '202': {
            description:
              'Async invocation accepted. Poll with GET `/gateway/{agentId}/runs/{runId}`.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AsyncInvokeResponse' } },
            },
          },
          '400': errorResponse('Invalid request body or engine not found.'),
          '401': errorResponse('Authentication failed.'),
          '403': errorResponse('Agent not published or IP not allowed.'),
          '404': errorResponse('Agent not found.'),
          '500': errorResponse('Execution error.'),
        },
      },
    },
    '/gateway/{agentId}/runs/{runId}': {
      get: {
        operationId: 'getRunStatus',
        summary: 'Get run status',
        description:
          'Retrieve the current status and result of a run. Useful for polling async invocations.',
        tags: ['Runs'],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/runId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        responses: {
          '200': {
            description: 'Run status retrieved.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GatewayRunStatusResponse' },
              },
            },
          },
          '401': errorResponse('Authentication failed.'),
          '403': errorResponse('Agent not published, IP not allowed, or run ownership mismatch.'),
          '404': errorResponse('Agent or run not found.'),
        },
      },
    },
    '/gateway/{agentId}/runs/{runId}/cancel': {
      post: {
        operationId: 'cancelRun',
        summary: 'Cancel a run',
        description:
          'Cancel a running or queued run. Already completed/failed/cancelled runs cannot be cancelled.',
        tags: ['Runs'],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/runId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        responses: {
          '200': {
            description: 'Run cancelled successfully.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CancelRunResponse' } },
            },
          },
          '400': errorResponse('Run is not cancellable.'),
          '401': errorResponse('Authentication failed.'),
          '403': errorResponse('Agent not published, IP not allowed, or run ownership mismatch.'),
          '404': errorResponse('Agent or run not found.'),
        },
      },
    },
    '/oauth/{agentId}/invoke': {
      post: {
        operationId: 'invokeAgentWithOAuth',
        summary: 'Invoke an agent with a caller OIDC JWT',
        description:
          'Invokes an OAuth-enabled published agent. `stream:true` returns SSE even when `async` is omitted. ' +
          'Caller authentication errors use HTTP 401 and CALLER/AUTH codes. Agent provider authentication failures use HTTP 424 and PROVIDER_* codes.',
        tags: ['OAuth Invoke'],
        security: [{ ssoJwt: [] }],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OAuthInvokeRequest' },
            },
          },
        },
        responses: {
          '200': {
            description:
              'Synchronous JSON success, or an SSE stream whose final event is done or error. SSE error.error uses OAuthGatewayError.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SyncInvokeResponse' } },
              'text/event-stream': { schema: { type: 'string' } },
            },
          },
          '202': {
            description: 'Invocation accepted. Poll the OAuth run endpoint.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AsyncInvokeResponse' } },
            },
          },
          '400': oauthErrorResponse('Malformed JSON or invalid request fields.'),
          '401': oauthErrorResponse(
            'Caller OIDC JWT is missing, invalid, or expired. Obtain a new caller token.',
          ),
          '403': oauthErrorResponse(
            'Caller, network, publication, or OAuth-channel policy denied access. The token must carry an email claim in every access mode; specified_users additionally requires a verified address on the agent allowlist.',
          ),
          '404': oauthErrorResponse('The requested agent does not exist.'),
          '409': oauthErrorResponse('The session or agent workspace is currently busy.'),
          '413': oauthErrorResponse('The request body exceeds the 10 MiB API limit.'),
          '422': oauthErrorResponse(
            'The request exceeded context limits or was rejected by provider policy.',
          ),
          '424': oauthErrorResponse(
            'The agent execution provider or configuration requires action by the agent owner.',
          ),
          '429': oauthErrorResponse('API request limit or agent queue limit reached.'),
          '500': oauthErrorResponse('Internal or unclassified execution failure.'),
          '503': oauthErrorResponse(
            'Authorization dependency, provider, or platform temporarily unavailable.',
          ),
          '504': oauthErrorResponse('Agent execution timed out.'),
        },
      },
    },
    '/oauth/{agentId}/runs/{runId}': {
      get: {
        operationId: 'getOAuthRunStatus',
        summary: 'Get an OAuth invocation run',
        tags: ['OAuth Runs'],
        security: [{ ssoJwt: [] }],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/runId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        responses: {
          '200': {
            description:
              'Run status. When status is failed, data.result.error is a caller-facing OAuthGatewayError.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OAuthRunStatusResponse' },
              },
            },
          },
          '401': oauthErrorResponse('Caller OIDC JWT is missing, invalid, or expired.'),
          '403': oauthErrorResponse(
            'Caller cannot access this agent or the run belongs to another agent.',
          ),
          '404': oauthErrorResponse('Agent or run not found.'),
          '503': oauthErrorResponse('Caller authorization dependency is unavailable.'),
        },
      },
    },
    '/oauth/{agentId}/runs/{runId}/cancel': {
      post: {
        operationId: 'cancelOAuthRun',
        summary: 'Cancel an OAuth invocation run',
        tags: ['OAuth Runs'],
        security: [{ ssoJwt: [] }],
        parameters: [
          { $ref: '#/components/parameters/agentId' },
          { $ref: '#/components/parameters/runId' },
          { $ref: '#/components/parameters/xRequestId' },
        ],
        responses: {
          '200': {
            description: 'Run cancelled.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CancelRunResponse' } },
            },
          },
          '400': oauthErrorResponse('Run has already reached a terminal state.'),
          '401': oauthErrorResponse('Caller OIDC JWT is missing, invalid, or expired.'),
          '403': oauthErrorResponse('Caller cannot access this agent or run.'),
          '404': oauthErrorResponse('Agent or run not found.'),
          '503': oauthErrorResponse('Caller authorization dependency is unavailable.'),
        },
      },
    },
  },
}
