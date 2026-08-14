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
    title: 'a2wave API',
    version: '1.2.0',
    description:
      'Authenticated SCM management plus API-key Gateway and enterprise OIDC OAuth APIs for invoking published agents, querying run results, and cancelling runs. ' +
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
      userSession: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Authenticated a2wave user session JWT, as used by the CLI.',
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
      scmSourceId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'SCM source ID (prefixed with `scm_`).',
      },
      workspaceName: {
        name: 'name',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Workspace/worktree name.',
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
      CreateScmSourceRequest: {
        oneOf: [
          {
            type: 'object',
            required: ['name', 'type', 'config'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              type: { type: 'string', enum: ['git'] },
              description: { type: 'string', nullable: true },
              config: {
                type: 'object',
                required: ['type', 'repoUrl'],
                properties: {
                  type: { type: 'string', enum: ['git'] },
                  repoUrl: { type: 'string' },
                  branch: { type: 'string', default: 'main' },
                  repos: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
                additionalProperties: true,
              },
              localPath: {
                type: 'string',
                description:
                  'Optional absolute custom checkout path. Omit it to allocate platform-managed persistent Git storage.',
              },
              workspacesPath: { type: 'string', nullable: true },
              isEnabled: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            required: ['name', 'type', 'config', 'localPath'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              type: { type: 'string', enum: ['p4'] },
              description: { type: 'string', nullable: true },
              config: {
                type: 'object',
                required: ['type', 'p4port', 'p4user', 'p4client'],
                properties: {
                  type: { type: 'string', enum: ['p4'] },
                  p4port: { type: 'string' },
                  p4user: { type: 'string' },
                  p4passwd: { type: 'string', format: 'password' },
                  p4client: { type: 'string' },
                },
                additionalProperties: true,
              },
              localPath: {
                type: 'string',
                description: 'Required absolute P4 client checkout path.',
              },
              workspacesPath: { type: 'string', nullable: true },
              isEnabled: { type: 'boolean' },
            },
          },
        ],
      },
      ProbeScmSourceRequest: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'config'],
            properties: {
              type: { type: 'string', enum: ['git'] },
              config: {
                type: 'object',
                required: ['type', 'repoUrl'],
                properties: {
                  type: { type: 'string', enum: ['git'] },
                  repoUrl: { type: 'string' },
                  branch: { type: 'string', default: 'main' },
                  repos: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
                additionalProperties: true,
              },
              localPath: { type: 'string' },
              sourceId: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['type', 'config', 'localPath'],
            properties: {
              type: { type: 'string', enum: ['p4'] },
              config: {
                type: 'object',
                required: ['type', 'p4port', 'p4user', 'p4client'],
                properties: {
                  type: { type: 'string', enum: ['p4'] },
                  p4port: { type: 'string' },
                  p4user: { type: 'string' },
                  p4passwd: { type: 'string', format: 'password' },
                  p4client: { type: 'string' },
                },
                additionalProperties: true,
              },
              localPath: {
                type: 'string',
                description: 'Required so the probe can validate P4 Root/AltRoots coverage.',
              },
              sourceId: { type: 'string' },
            },
          },
        ],
      },
      UpdateScmSourceRequest: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', nullable: true },
          config: { type: 'object', additionalProperties: true },
          localPath: { type: 'string', description: 'Absolute checkout path.' },
          workspacesPath: { type: 'string', nullable: true },
          isEnabled: { type: 'boolean' },
        },
      },
      ScmSource: {
        type: 'object',
        required: ['id', 'name', 'type', 'config', 'localPath', 'isEnabled'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['git', 'p4'] },
          description: { type: 'string', nullable: true },
          config: {
            type: 'object',
            description: 'SCM configuration with stored credentials masked.',
            additionalProperties: true,
          },
          localPath: { type: 'string' },
          workspacesPath: { type: 'string', nullable: true },
          isEnabled: { type: 'boolean' },
          syncStatus: { type: 'string', enum: ['idle', 'syncing', 'error'] },
          codegraphStatus: { type: 'string', enum: ['idle', 'indexing', 'error'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ScmSourceResponse: {
        type: 'object',
        properties: { data: { $ref: '#/components/schemas/ScmSource' } },
      },
      ScmSourceListResponse: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/ScmSource' } },
          pagination: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
              totalPages: { type: 'integer' },
            },
          },
        },
      },
      ScmProbeResponse: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            required: ['ok', 'message'],
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              serverVersion: { type: 'string' },
              clientRoot: {
                type: 'string',
                description: 'P4 Client Root detected from the server-side Client Spec.',
              },
              clientRootWarning: {
                type: 'string',
                description:
                  'P4 root-coverage diagnostic when the Client Spec cannot be read or localPath is not covered.',
              },
              repos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    directory: { type: 'string' },
                    repoUrl: { type: 'string' },
                    ok: { type: 'boolean' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      ScmStatusResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              syncStatus: { type: 'string', enum: ['idle', 'syncing', 'error'] },
              lastSyncAt: { type: 'string', format: 'date-time', nullable: true },
              lastSyncError: { type: 'string', nullable: true },
              initialSyncCompletedAt: { type: 'string', format: 'date-time', nullable: true },
              codegraphStatus: { type: 'string', enum: ['idle', 'indexing', 'error'] },
              codegraphLastIndexedAt: { type: 'string', format: 'date-time', nullable: true },
              codegraphLastError: { type: 'string', nullable: true },
            },
          },
        },
      },
      ScmWorkspaceListResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'path', 'occupied'],
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                occupied: { type: 'boolean' },
                cleanup: { type: 'string', nullable: true },
                lastRunId: { type: 'string', nullable: true },
                repos: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
          },
        },
      },
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
    '/scm-sources': {
      get: {
        operationId: 'listScmSources',
        summary: 'List visible SCM sources',
        description: 'Deletion-reserved sources are omitted from the visible list.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        responses: {
          '200': {
            description: 'Paginated SCM source list with stored credentials masked.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScmSourceListResponse' },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createScmSource',
        summary: 'Create an SCM source',
        description:
          'Creates Git or P4 source storage. Git allocates a managed persistent checkout when localPath is omitted; P4 requires an explicit localPath.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateScmSourceRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'SCM source created.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmSourceResponse' } },
            },
          },
          '400': { description: 'Invalid source configuration or storage path.' },
          '409': { description: 'Storage path conflicts with another source.' },
        },
      },
    },
    '/scm-sources/probe': {
      post: {
        operationId: 'probeScmSource',
        summary: 'Probe SCM connectivity without saving',
        description:
          'Probes the supplied Git or P4 configuration. P4 requires localPath so client Root/AltRoots coverage is validated; Git probes only remote connectivity.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProbeScmSourceRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Probe result, including P4 Client Root diagnostics when available.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmProbeResponse' } },
            },
          },
          '400': { description: 'Invalid probe input or type/path mismatch.' },
          '404': { description: 'sourceId is not visible to the caller.' },
          '429': { description: 'Probe rate limit exceeded.' },
        },
      },
    },
    '/scm-sources/{id}': {
      get: {
        operationId: 'getScmSource',
        summary: 'Get an SCM source',
        description: 'Deletion-reserved sources are no longer visible through this endpoint.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '200': {
            description: 'SCM source with stored credentials masked.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmSourceResponse' } },
            },
          },
          '404': { description: 'SCM source not found, not visible, or pending deletion.' },
        },
      },
      patch: {
        operationId: 'updateScmSource',
        summary: 'Update an SCM source',
        description:
          'Updates source metadata, configuration, or storage paths. Configuration/path changes return 409 while a durable workload, sync/index job, deletion, or workspace removal owns the source.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateScmSourceRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'SCM source updated; stored credentials remain masked.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmSourceResponse' } },
            },
          },
          '400': { description: 'Invalid configuration or unsafe storage path.' },
          '404': { description: 'SCM source not found or not visible.' },
          '409': { description: 'Source lifecycle is busy or deletion is pending.' },
        },
      },
      delete: {
        operationId: 'deleteScmSource',
        summary: 'Delete an SCM source and reclaim managed storage',
        description:
          'Durably reserves deletion, isolates managed storage, then deletes the row. A 503 means deletion remains reserved and is safe to retry; custom operator-owned paths are never reclaimed.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '200': {
            description: 'Source and any managed storage were deleted.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmSourceResponse' } },
            },
          },
          '404': { description: 'SCM source not found or not visible.' },
          '409': {
            description:
              'Source is referenced, busy, pinned by a durable workload, or has a workspace removal in progress.',
          },
          '503': {
            description:
              'Deletion is durably pending because managed storage could not yet be isolated; retry later.',
          },
        },
      },
    },
    '/scm-sources/{id}/sync': {
      post: {
        operationId: 'syncScmSource',
        summary: 'Start an SCM sync',
        description: 'Starts a background sync after atomically claiming the checkout.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '202': { description: 'Background sync started.' },
          '404': { description: 'SCM source not found or not visible.' },
          '409': { description: 'A sync or index job already owns the checkout.' },
        },
      },
    },
    '/scm-sources/{id}/check': {
      post: {
        operationId: 'checkScmSource',
        summary: 'Check a saved SCM source connection',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '200': {
            description: 'Connection result, including P4 Client Root diagnostics when available.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmProbeResponse' } },
            },
          },
          '400': { description: 'Unsupported SCM type.' },
          '404': { description: 'SCM source not found or not visible.' },
        },
      },
    },
    '/scm-sources/{id}/status': {
      get: {
        operationId: 'getScmSourceStatus',
        summary: 'Get SCM sync and CodeGraph status',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '200': {
            description: 'Current sync and indexing status.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScmStatusResponse' } },
            },
          },
          '400': { description: 'The saved workspace root is unsafe and must be migrated.' },
          '404': { description: 'SCM source not found or not visible.' },
        },
      },
    },
    '/scm-sources/{id}/codegraph/reindex': {
      post: {
        operationId: 'reindexScmSourceCodegraph',
        summary: 'Start CodeGraph indexing',
        description: 'Starts background indexing after atomically claiming the checkout.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '202': { description: 'Background indexing started.' },
          '400': { description: 'CodeGraph is disabled for this source.' },
          '404': { description: 'SCM source not found or not visible.' },
          '409': { description: 'A sync or index job already owns the checkout.' },
          '500': { description: 'Index startup failed and its checkout claim was released.' },
        },
      },
    },
    '/scm-sources/{id}/workspaces': {
      get: {
        operationId: 'listScmSourceWorkspaces',
        summary: 'List source workspaces',
        description: 'Lists Git worktrees with their current occupied state.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [{ $ref: '#/components/parameters/scmSourceId' }],
        responses: {
          '200': {
            description: 'Workspace list.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScmWorkspaceListResponse' },
              },
            },
          },
          '400': { description: 'Workspaces are unsupported or the saved root is unsafe.' },
          '404': { description: 'SCM source not found or not visible.' },
        },
      },
    },
    '/scm-sources/{id}/workspaces/{name}': {
      delete: {
        operationId: 'deleteScmSourceWorkspace',
        summary: 'Delete a source workspace',
        description:
          'Uses the durable removal-reservation protocol and refuses while any other workload occupies the workspace.',
        tags: ['SCM Sources'],
        security: [{ userSession: [] }],
        parameters: [
          { $ref: '#/components/parameters/scmSourceId' },
          { $ref: '#/components/parameters/workspaceName' },
        ],
        responses: {
          '200': { description: 'Workspace removed.' },
          '400': { description: 'Invalid workspace name, unsupported source, or unsafe root.' },
          '404': { description: 'SCM source not found or not visible.' },
          '409': { description: 'Workspace is occupied or another removal owns the target.' },
        },
      },
    },
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
