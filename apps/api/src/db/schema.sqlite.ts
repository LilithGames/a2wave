import {
  type A2ARouteTarget,
  type artifactPolicySchema,
  type chatAppConfigSchema,
  type discordConfigSchema,
  type feishuConfigSchema,
  type ghTriggerConfigSchema,
  type gitTriggerRepoStateSchema,
  type glabTriggerConfigSchema,
  PROVIDER_KINDS,
  type RemoteSkillSource,
  SKILL_DEFAULTS,
  type scheduleConfigSchema,
  type slackConfigSchema,
} from '@a2wave/shared'
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { z } from 'zod'

// ============================================================
// Users - user table
// ============================================================
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(), // usr_xxx
    username: text('username').notNull().unique(),
    displayName: text('display_name'),
    /** Role: admin | user */
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    /** Password hash (Argon2id); NULL = no password set (setup state / SSO-only user) */
    passwordHash: text('password_hash'),
    /** SSO email: from the IdP JWT email claim; (partial) unique index, used to align SSO identities */
    email: text('email'),
    /**
     * IdP sub: from the IdP JWT sub / OIDC sub / SAML NameID; a stable identity anchor.
     * Uniqueness is namespaced by the composite (idaas_issuer, idaas_sub) (see idaasIdentityIdx
     * below): SAML NameID / OIDC sub / JWT sub may all be overlapping values such as email
     * addresses, unique only within their own issuer and never globally, otherwise a second IdP's
     * identically named subject would match the first account. Identity queries must always filter
     * by issuer as well.
     */
    idaasSub: text('idaas_sub'),
    /**
     * IdP issuer the SSO identity belongs to (OIDC metadata issuer / SAML assertion issuer / JWT
     * pass-through issuer). Used to audit the identity's origin; when merging by email across SSO
     * methods within one enterprise trust domain the issuer is not compared, because each
     * protocol's issuer string naturally differs. All enabled SSO methods must be configured by an
     * administrator to point at the same trust domain. Null for local password accounts.
     */
    idaasIssuer: text('idaas_issuer'),
    /**
     * Which SSO protocol established the binding: 'oidc' | 'saml'.
     *
     * Recorded so the UI can state how an identity is bound instead of inferring it from the
     * currently enabled login methods — an inference that silently relabels every existing
     * binding whenever a deployment changes protocols.
     *
     * Null for local password accounts and for SSO rows written before this column existed;
     * consumers must treat null as "bound, protocol unknown" rather than "not bound" — that
     * distinction is still carried by idaasSub.
     */
    idaasProtocol: text('idaas_protocol'),
    /** UI language preference: zh | en */
    locale: text('locale').notNull().default('zh'),
    /**
     * First-time user experience (FTUE) completion state, stored as JSON keyed by guide id so more
     * guides can be added later. Shaped like { "newbie": "completed" | "dismissed" }; absent =
     * undecided (the prompt is still shown).
     */
    onboarding: text('onboarding', { mode: 'json' })
      .$type<Record<string, 'completed' | 'dismissed'>>()
      .notNull()
      .default(sql`'{}'`),
    /** Whether the account is active */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /**
     * Token version — used for server-side JWT revocation. Incremented on every logout / password
     * change / admin password reset / role change; authMiddleware compares the token's `tv` claim
     * against the DB's tokenVersion and returns 401 on a mismatch.
     */
    tokenVersion: integer('token_version').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    emailIdx: uniqueIndex('users_email_unique').on(table.email),
    // The identity key is namespaced by (issuer, sub): identically named subjects from different
    // IdPs are different people and must not share a uniqueness slot, otherwise a second IdP's
    // matching sub would take over the first account at login (cross-protocol / cross-IdP
    // takeover). Legacy rows may have an empty idaas_issuer (in SQLite, NULLs are never equal to
    // each other inside a unique index); uniqueness of their sub is backstopped by the unique
    // email plus the email-based cross-protocol merge path. Newly written SSO accounts always
    // have a non-empty issuer.
    idaasIdentityIdx: uniqueIndex('users_idaas_identity_unique').on(
      table.idaasIssuer,
      table.idaasSub,
    ),
  }),
)

// ============================================================
// User Invitations - invite links that let a new colleague create their own account
// ============================================================
/**
 * An administrator issues an invitation instead of typing someone else's password.
 *
 * The row is the single source of truth for whether a link still works, so it records both
 * of the terminal transitions explicitly (`acceptedAt`, `revokedAt`) rather than deleting
 * itself: a consumed or withdrawn invitation must stay auditable, and the accept path needs
 * to tell "already used" apart from "never existed" to give the invitee an actionable
 * message.
 *
 * Status is *derived*, never stored — a stored `expired` would only become true when some
 * sweeper happened to run, so a link would keep working past its deadline until then.
 */
export const userInvitations = sqliteTable(
  'user_invitations',
  {
    id: text('id').primaryKey(), // inv_xxx
    /**
     * The secret in the invite URL. Unique so the lookup is a single indexed read, and
     * generated with 32 bytes of CSPRNG entropy — it is a bearer credential for account
     * creation, and the accept endpoint is unauthenticated by design.
     */
    code: text('code').notNull().unique(),
    /**
     * Address the invitation is pinned to, lowercased. Null means the admin issued an
     * unpinned link and the invitee supplies their own address. When set, accept refuses a
     * different address, so forwarding the link does not silently transfer the invitation.
     */
    email: text('email'),
    /** Role the created account receives. Only an admin can choose it, at issue time. */
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    /** Free-form admin memo ("contractor, Q3 project"). Never rendered to the invitee. */
    note: text('note'),
    /** Administrator who issued it. Nullable so deleting that admin does not delete history. */
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    /** Account created by accepting it; null while pending. */
    acceptedUserId: text('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // The admin list orders by created_at DESC with a LIMIT; the pending-duplicate check
    // filters by email. Both would otherwise scan a table that only ever grows.
    createdAtIdx: index('user_invitations_created_at_idx').on(table.createdAt),
    emailIdx: index('user_invitations_email_idx').on(table.email),
  }),
)

// ============================================================
// Audit Logs - audit log
// ============================================================
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(), // aud_xxx
    userId: text('user_id').references(() => users.id),
    /** Action type */
    action: text('action').notNull(),
    /** Resource type */
    resource: text('resource'),
    /** ID of the resource acted upon */
    resourceId: text('resource_id'),
    /** Action details JSON */
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Source IP of the request */
    ipAddress: text('ip_address'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // GET /api/audit-logs filters by user_id/action/resource and always orders by
  // created_at DESC with a LIMIT. Without these the table (which never GC'd
  // before this branch's retention sweep) was a full scan + filesort per page.
  (table) => ({
    createdAtIdx: index('audit_logs_created_at_idx').on(table.createdAt),
    actionCreatedAtIdx: index('audit_logs_action_created_at_idx').on(table.action, table.createdAt),
    userIdCreatedAtIdx: index('audit_logs_user_id_created_at_idx').on(
      table.userId,
      table.createdAt,
    ),
    resourceCreatedAtIdx: index('audit_logs_resource_created_at_idx').on(
      table.resource,
      table.createdAt,
    ),
  }),
)

// ============================================================
// Providers - execution-engine configuration shared globally without a userId
// ============================================================
export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(), // prv_xxx
    /** Stable runtime identity; display name changes must not affect engine dispatch. */
    kind: text('kind', {
      enum: PROVIDER_KINDS,
    })
      .notNull()
      .default('cursor'),
    name: text('name').notNull(),
    description: text('description'),
    /** Built-in preset that cannot be modified or deleted. */
    isPreset: integer('is_preset', { mode: 'boolean' }).notNull().default(false),
    /** Initialization script that installs engine dependencies. */
    initScript: text('init_script'),
    /** Probe script that verifies the engine is installed. */
    checkScript: text('check_script'),
    /** Skill synchronization directory relative to workDir; null means prompt injection. */
    skillsDir: text('skills_dir'),
    /** MCP configuration path relative to workDir. */
    mcpConfigPath: text('mcp_config_path'),
    /** Provider-specific extension configuration. */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex('providers_kind_unique').on(table.kind)],
)

// ============================================================
// MCP Servers - MCP server configuration
// ============================================================
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(), // mcp_xxx
  name: text('name').notNull(),
  description: text('description'),
  /** Transport: stdio | sse | http | group */
  type: text('type', { enum: ['stdio', 'sse', 'http', 'group'] })
    .notNull()
    .default('stdio'),
  /** stdio: launch command */
  command: text('command'),
  /** stdio: command argument array */
  args: text('args', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  /** stdio: subprocess working directory */
  cwd: text('cwd'),
  /** sse/http: remote server URL */
  url: text('url'),
  /** sse/http: custom request headers */
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>(),
  /** Common: environment variables */
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  /** group: multi-backend configuration */
  groupConfig: text('group_config', { mode: 'json' }).$type<import('@a2wave/shared').GroupConfig>(),
  /** Whether enabled */
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Usage scope: who may bind/run it ('private' owner only | 'admin-only' admins only | 'all-users' everyone, settable by admins only). */
  usageScope: text('usage_scope', { enum: ['private', 'admin-only', 'all-users'] })
    .notNull()
    .default('private'),
  /** Owning user */
  userId: text('user_id').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// ============================================================
// Skill Groups - Skill grouping (named groups, displayed/mounted per group; a Skill can belong
// to only one group)
// ============================================================
export const skillGroups = sqliteTable('skill_groups', {
  id: text('id').primaryKey(), // skg_xxx
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon').notNull().default('package'),
  /** Owning user */
  userId: text('user_id').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// ============================================================
// Skills - reusable Agent skills
// ============================================================
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(), // skl_xxx
  name: text('name').notNull(),
  description: text('description'),
  /** Skill instruction content (the SKILL.md body) */
  content: text('content'),
  /** Storage path: relative to the skills root, e.g. skl_xxx; null means content only, no files */
  storagePath: text('storage_path'),
  /** Owning group (skg_xxx); null = ungrouped. SET NULL when the group is deleted */
  groupId: text('group_id').references(() => skillGroups.id, { onDelete: 'set null' }),
  /** Owning user */
  userId: text('user_id').references(() => users.id),
  /** Visibility: creator-only by default; only admins may publish to all users. */
  visibility: text('visibility', { enum: ['private', 'all-users'] })
    .notNull()
    .default(SKILL_DEFAULTS.visibility),
  /** Reproducible remote-install provenance; null for manually created/uploaded skills. */
  remoteSource: text('remote_source', { mode: 'json' }).$type<RemoteSkillSource>(),
  /** Set after local edits make the installed skill diverge from its recorded remote snapshot. */
  sourceDirty: integer('source_dirty', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// ============================================================
// KB Documents - knowledge base documents
// ============================================================
export const kbDocuments = sqliteTable('kb_documents', {
  id: text('id').primaryKey(), // kbd_xxx
  name: text('name').notNull(),
  description: text('description'),
  /** Source type: feishu | upload | notion */
  sourceType: text('source_type', { enum: ['feishu', 'upload', 'notion'] }).notNull(),
  // Feishu fields
  feishuDocToken: text('feishu_doc_token'),
  feishuDocType: text('feishu_doc_type'),
  feishuUrl: text('feishu_url'),
  feishuAppId: text('feishu_app_id'),
  feishuAppSecret: text('feishu_app_secret'),
  // Notion fields
  notionPageId: text('notion_page_id'),
  notionUrl: text('notion_url'),
  notionToken: text('notion_token'),
  // Upload fields
  originalFilename: text('original_filename'),
  mimeType: text('mime_type'),
  // Common
  storagePath: text('storage_path'),
  contentHash: text('content_hash'),
  fileSize: integer('file_size'),
  /** Sync status: idle | syncing | synced | error */
  syncStatus: text('sync_status', { enum: ['idle', 'syncing', 'synced', 'error'] })
    .notNull()
    .default('idle'),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  lastSyncError: text('last_sync_error'),
  /** Whether to sync automatically */
  autoSync: integer('auto_sync', { mode: 'boolean' }).notNull().default(true),
  /** Sync interval (minutes) */
  syncIntervalMin: integer('sync_interval_min').notNull().default(60),
  /** Owning user */
  userId: text('user_id').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// ============================================================
// SCM Sources - code sources (P4, Git, etc.)
// ============================================================
export const scmSources = sqliteTable('scm_sources', {
  id: text('id').primaryKey(), // scm_xxx
  name: text('name').notNull(),
  /** Source type: p4 | git */
  type: text('type', { enum: ['p4', 'git'] }).notNull(),
  description: text('description'),
  /** SCM-specific configuration JSON (varies by type) */
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** Local working directory (absolute path, unique) */
  localPath: text('local_path').notNull().unique(),
  /** Sync status */
  syncStatus: text('sync_status', { enum: ['idle', 'syncing', 'error'] })
    .notNull()
    .default('idle'),
  /** Last sync time */
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  /** Last sync error message */
  lastSyncError: text('last_sync_error'),
  /** Completion time of the initial sync (written on the first successful sync) */
  initialSyncCompletedAt: integer('initial_sync_completed_at', { mode: 'timestamp' }),
  /** CodeGraph index status */
  codegraphStatus: text('codegraph_status', { enum: ['idle', 'indexing', 'error'] })
    .notNull()
    .default('idle'),
  /** Time of the most recent successful CodeGraph index */
  codegraphLastIndexedAt: integer('codegraph_last_indexed_at', { mode: 'timestamp' }),
  /** Most recent CodeGraph indexing error */
  codegraphLastError: text('codegraph_last_error'),
  /** Worktree root directory (defaults to ~/.a2wave/workspaces/<sourceIdSuffix>, globally unique) */
  workspacesPath: text('workspaces_path').unique(),
  /** Whether enabled */
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  /** Durable first phase of an SCM source deletion. */
  deletionRequestedAt: integer('deletion_requested_at', { mode: 'timestamp' }),
  /** User who requested deletion, retained for crash-recovery audit attribution. */
  deletionRequestedBy: text('deletion_requested_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  /** Owning user */
  userId: text('user_id').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// ============================================================
// Agents - Agent definitions
// ============================================================
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** Agent type: llm | cursor | script */
    type: text('type', { enum: ['llm', 'cursor', 'script'] })
      .notNull()
      .default('cursor'),
    /** Agent configuration JSON */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Status: active | inactive */
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    /** Agent icon */
    icon: text('icon').notNull().default('🤖'),
    /** System prompt */
    systemPrompt: text('system_prompt'),
    /** Skills list JSON (Skill ID references) */
    skills: text('skills', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    /** Mounted Skill group IDs (skg_xxx); merged with `skills` and deduplicated at runtime */
    skillGroupIds: text('skill_group_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    /** Mounted MCP Server IDs */
    mcpServerIds: text('mcp_server_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    /** Mounted knowledge base document IDs */
    kbDocumentIds: text('kb_document_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    /** Publish status: draft | published | stopped */
    publishStatus: text('publish_status', { enum: ['draft', 'published', 'stopped'] })
      .notNull()
      .default('draft'),
    /** Per-agent Provider API Key (entered on the Config page, used by the cursor CLI) */
    providerApiKey: text('provider_api_key'),
    /** Per-agent Provider Base URL (entered on the Config page, used by Providers such as Claude Code) */
    providerBaseUrl: text('provider_base_url'),
    /** Per-agent Claude Code OAuth Token (generated by `claude setup-token`, effective for Claude Code only) */
    providerOauthToken: text('provider_oauth_token'),
    /** @deprecated Auto-memory now inherits the Agent Provider credentials; the old column is kept only for historical data compatibility */
    memoryProviderApiKey: text('memory_provider_api_key'),
    /** Embedding API Key (vector search) */
    embeddingApiKey: text('embedding_api_key'),
    /** Credential mode: apiKey = inject providerApiKey; oauth = inject providerOauthToken; localSession = use the CLI's local login state */
    authMode: text('auth_mode', { enum: ['apiKey', 'oauth', 'localSession'] })
      .notNull()
      .default('apiKey'),
    /** Gateway endpoint auth key (generated automatically on Publish, used by external callers) */
    endpointApiKey: text('endpoint_api_key'),
    /** Auth method: none | api_key (oauth has been promoted to a standalone channel, see publishChannels) */
    publishAuthType: text('publish_auth_type', { enum: ['none', 'api_key'] }).default('api_key'),
    /** IP allowlist JSON */
    publishIpWhitelist: text('publish_ip_whitelist', { mode: 'json' })
      .$type<string[]>()
      .$defaultFn(() => []),
    /** Publish description */
    publishDescription: text('publish_description'),
    /** Publish channels JSON: ['api'] | ['a2a'] | ['api', 'a2a'] */
    publishChannels: text('publish_channels', { mode: 'json' })
      .$type<string[]>()
      .$defaultFn(() => ['api']),
    /**
     * OAuth channel access scope.
     *
     * The **column** default is still the retired `'feishu_scope'` from migration 0071, and the
     * enum lists it so this declaration matches the database rather than a cast pretending
     * otherwise. Changing a SQLite column default requires a full table rebuild, which for this
     * table is unsafe under the live foreign keys `db/client.ts` enables (see 0100's header).
     *
     * ⚠️ **This default is not inert.** Drizzle binds it into every INSERT as a parameter, so
     * omitting the column from an insert writes `'feishu_scope'` — it does not fall through to
     * SQLite. Reads normalize that to the *open* mode, so an insert path that forgets this
     * column silently downgrades an Agent's access tier to "all enterprise users". The clone
     * route did exactly that. **Every insert must pass `oauthAccessMode` explicitly**, choosing
     * the restricted tier when the source's tier is unclear.
     *
     * The intended default is the Zod one (`agentSchema.oauthAccessMode`); read sites go through
     * `normalizeOauthAccessMode()`.
     */
    oauthAccessMode: text('oauth_access_mode', {
      enum: ['all_idaas_users', 'specified_users', 'feishu_scope'],
    })
      .notNull()
      .default('feishu_scope'),
    /** Email allowlist JSON, consulted only when oauthAccessMode = 'specified_users' */
    oauthAllowedEmails: text('oauth_allowed_emails', { mode: 'json' }).$type<string[]>(),
    /** A2A Skills JSON - skill descriptions used when the Agent is published as A2A */
    a2aSkills: text('a2a_skills', { mode: 'json' }).$type<
      Array<{ id: string; name: string; description: string; tags: string[] }>
    >(),
    /** A2A route targets JSON - list of targets this Agent may invoke (local + remote) */
    a2aRouteTargets: text('a2a_route_targets', { mode: 'json' }).$type<A2ARouteTarget[]>(),
    /** Whether to show local child Agent output in streaming cards (default true) */
    showLocalChildOutput: integer('show_local_child_output', { mode: 'boolean' }),
    /** Whether to show remote child Agent output in streaming cards (default true) */
    showRemoteChildOutput: integer('show_remote_child_output', { mode: 'boolean' }),
    /**
     * Feishu bot configuration JSON
     *
     * Uses the zod input type (z.input<>) rather than the output type (z.infer<>):
     * older DB rows may have been written without fields that zod fills in by default
     * (such as fetchUserInfo). The input type keeps those fields optional, so the types
     * do not lie when reading legacy data.
     */
    feishuConfig: text('feishu_config', { mode: 'json' }).$type<
      z.input<typeof feishuConfigSchema>
    >(),
    /** Slack Socket Mode bot configuration JSON. */
    slackConfig: text('slack_config', { mode: 'json' }).$type<z.input<typeof slackConfigSchema>>(),
    /** Discord Gateway bot configuration JSON. */
    discordConfig: text('discord_config', { mode: 'json' }).$type<
      z.input<typeof discordConfigSchema>
    >(),
    /** Chat app page presentation config JSON (copy only — never credentials). */
    chatAppConfig: text('chat_app_config', { mode: 'json' }).$type<
      z.input<typeof chatAppConfigSchema>
    >(),
    /** Artifact distribution policy JSON */
    artifactPolicy: text('artifact_policy', { mode: 'json' }).$type<
      z.input<typeof artifactPolicySchema>
    >(),
    /** Scheduled trigger configuration JSON (input type, same as feishuConfig) */
    scheduleConfig: text('schedule_config', { mode: 'json' }).$type<
      z.input<typeof scheduleConfigSchema>
    >(),
    /**
     * GitLab / GitHub repository polling trigger config JSON.
     *
     * Holds no credentials: forge auth lives in the `glab` / `gh` CLI's own
     * keyring, so these columns never need masking on read paths.
     */
    /**
     * Typed to the provider-bound variants, not the shared shape: a `glab`
     * config written into `gh_config` validated fine at runtime and then
     * silently never polled. Binding the column to a literal provider turns
     * that into a compile error at every write path, so a new one cannot forget
     * the guard the way three earlier ones did.
     */
    glabConfig: text('glab_config', { mode: 'json' }).$type<
      z.input<typeof glabTriggerConfigSchema>
    >(),
    ghConfig: text('gh_config', { mode: 'json' }).$type<z.input<typeof ghTriggerConfigSchema>>(),
    /** Publish time */
    publishedAt: integer('published_at', { mode: 'timestamp' }),
    /** Provider ID - execution engine */
    providerId: text('provider_id').references(() => providers.id),
    /** Environment variables JSON */
    env: text('env', { mode: 'json' }).$type<
      Record<string, { value: string; sensitive: boolean }>
    >(),
    /** Working directory type: scm = linked code source, temp = temporary directory */
    workspaceType: text('workspace_type', { enum: ['scm', 'temp'] })
      .notNull()
      .default('temp'),
    /** Linked SCM source ID */
    scmSourceId: text('scm_source_id').references(() => scmSources.id),
    /** Maximum concurrency (1-5); the default of 1 means sequential execution */
    maxConcurrency: integer('max_concurrency').notNull().default(1),
    /** Dedicated inbound A2A auth method (decoupled from the REST API channel); none = no auth, api_key = a dedicated key is required */
    a2aAuthType: text('a2a_auth_type', { enum: ['none', 'api_key'] })
      .notNull()
      .default('api_key'),
    /** API Key dedicated to inbound A2A (independent of endpointApiKey, prefixed a2ak_, held only by trusted sibling agents) */
    a2aEndpointApiKey: text('a2a_endpoint_api_key'),
    /** Trust the user identity forwarded by an upstream A2A: only an a2a hop with a2aAuthType=api_key adopts the upstream user_info as the run's identity */
    trustForwardedIdentity: integer('trust_forwarded_identity', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * Scheduled runs are attributed to the SSO identity bound to "whoever turned this switch
     * on". An on/off switch; the specific identity is in scheduleRunAsUserId.
     */
    scheduleRunAsOwner: integer('schedule_run_as_owner', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * User owning the scheduled run identity: pinned server-side at publish time to "the
     * logged-in user who enabled scheduleRunAsOwner"; a client cannot designate someone else.
     * Their email/idaasSub is resolved live at trigger time; disabling or unbinding the user
     * takes effect immediately.
     */
    scheduleRunAsUserId: text('schedule_run_as_user_id').references(() => users.id),
    /** Owning user */
    userId: text('user_id').references(() => users.id),
    /**
     * Pin timestamp (millisecond precision): non-null means pinned; the list sorts by ascending
     * pinnedAt ahead of unpinned items. Written only via the pin/unpin routes.
     * Uses timestamp_ms rather than second-level timestamp — when several Agents are pinned in
     * quick succession within the same second, only millisecond precision can order them by
     * click order.
     */
    pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userIdIdx: index('agents_user_id_idx').on(table.userId),
  }),
)

// ============================================================
// Runs - run log (task execution instances)
// ============================================================
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    /** Trigger intent */
    intent: text('intent').notNull(),
    /** Status: pending | queued | running | completed | failed | cancelled */
    status: text('status', {
      enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    /** Execution result JSON */
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Internal execution metadata: used only by the queued/recovery execution paths, never surfaced as a user-visible result */
    executionMetadata: text('execution_metadata', { mode: 'json' }).$type<{
      oauthEngineType?: string
      oauthPreviousChatId?: string
      oauthResetSession?: boolean
      /**
       * Attachment refs for the queued path (persisted, so they are not lost to TTL expiry or a
       * restart the way an in-memory-only pending context would be).
       * token = staged replay (consumption is authorized); uri = external http(s) replay (the A2A
       * uri audit ref carried back by a rerun).
       */
      attachments?: {
        token?: string
        uri?: string
        name: string
        mimeType: string
        size?: number
      }[]
      /** Consumer identity for queued attachments (authorizes token consumption; REST = userId, gateway/oauth = agent:<id>). */
      attachmentConsumerId?: string
      /**
       * OAuth caller identity (`oauth:<issuer>:<sub>`, see oauthUploaderId). In all_idaas_users
       * mode a single published agent can be invoked by many IdP users, who are independent
       * principals outside the trust boundary; GET run / cancel must verify that the caller ===
       * this field, otherwise obtaining someone else's runId would allow reading their result
       * (which may contain private data) or cancelling their run. Written only for runs triggered
       * through the OAuth channel; absent = historical data, conservatively allowed to be read by
       * an unknown caller.
       */
      oauthCallerId?: string
      /**
       * Authenticated backend requester whose active admin role may authorize
       * admin-only/stdio MCP capabilities. Persist only the user id; execution
       * re-reads role and active state so queued/recovered work cannot retain a
       * stale privilege decision. External channels never set this field.
       */
      runtimeAdminRequesterUserId?: string
      /**
       * Marks that this turn's queued input has not yet been materialized into a step. When a
       * multi-turn conversation reuses one run, the latest step may belong to the previous turn;
       * as long as this marker is present, the turn matching the current intent has not
       * materialized, so a rerun must use this turn's executionMetadata.attachments (which may be
       * empty = no attachments this turn) and must never read back the previous turn's step
       * attachments. Cleared by executeChatRun once the step is persisted (see the consume-once
       * handoff in execute-chat-run.ts).
       */
      queuedTurn?: boolean
      /** Persisted Slack/Discord context for queued and restart execution. */
      nativeChatContext?: Record<string, unknown>
      /** Durable remote identifiers resolved only after native event reservation/acknowledgement. */
      nativeAttachments?: (
        | {
            source: 'slack'
            remoteId: string
            name: string
            mimeType?: string
            size?: number
          }
        | {
            source: 'discord'
            remoteId: string
            channelId: string
            messageId: string
            name: string
            mimeType?: string
            size?: number
          }
      )[]
    }>(),
    /** Run trigger transport. */
    triggerSource: text('trigger_source', {
      enum: [
        'debug',
        'api',
        'feishu',
        'slack',
        'discord',
        'a2a',
        'schedule',
        'oauth',
        'chat_app',
        'glab',
        'gh',
      ],
    }),
    /** Session ID within the trigger source (e.g. Feishu thread_id / p2p chat_id / group message_id) */
    triggerSessionId: text('trigger_session_id'),
    /** Native chat source event id for durable redelivery deduplication. */
    triggerEventId: text('trigger_event_id'),
    /** Actual working directory (worktree path or localPath) */
    workDir: text('work_dir'),
    /** Worktree configuration JSON (name + optional branch + cleanup policy) */
    worktreeConfig: text('worktree_config', { mode: 'json' }).$type<{
      name: string
      branch?: string
      cleanup: 'ephemeral' | 'persistent' | 'ttl'
    }>(),
    /** Initiating Agent */
    initiatorAgentId: text('initiator_agent_id').references(() => agents.id),
    /** Owning user */
    userId: text('user_id').references(() => users.id),
    /**
     * Trigger user's best available display name, unified across channels.
     * Feishu takes user.name (independent of whether an email exists), debug takes the logged-in
     * user's displayName, and oauth/api/a2a take oauthCaller.userInfo.username; NULL for schedule
     * and pure api_key. Remote A2A may carry an audit-only asserted display name
     * through the optional caller-provenance extension without creating user_info.
     */
    triggerUserName: text('trigger_user_name'),
    /** Immediate caller Agent display name for remote and local A2A provenance. */
    triggerAgentName: text('trigger_agent_name'),
    /** Cumulative input tokens across turns; NULL means untracked. */
    inputTokens: integer('input_tokens'),
    /** Cumulative output tokens. */
    outputTokens: integer('output_tokens'),
    /** Cumulative reasoning tokens. */
    reasoningTokens: integer('reasoning_tokens'),
    /** Cumulative cache-read tokens. */
    cacheReadTokens: integer('cache_read_tokens'),
    /** Cumulative cache-write tokens. */
    cacheWriteTokens: integer('cache_write_tokens'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    initiatorAgentIdIdx: index('runs_initiator_agent_id_idx').on(table.initiatorAgentId),
    initiatorAgentSessionStatusCreatedAtIdx: index(
      'runs_agent_trigger_session_status_created_at_idx',
    ).on(table.initiatorAgentId, table.triggerSessionId, table.status, table.createdAt),
    idempotencyKeyUnique: uniqueIndex('runs_idempotency_key_unique')
      .on(table.initiatorAgentId, table.triggerSource, table.triggerSessionId)
      .where(
        sql`trigger_source IN ('api', 'a2a') AND trigger_session_id IS NOT NULL AND status IN ('pending', 'queued', 'running', 'completed')`,
      ),
    oauthActiveSessionUnique: uniqueIndex('runs_oauth_active_session_unique')
      .on(table.initiatorAgentId, table.triggerSource, table.triggerSessionId)
      .where(
        sql`trigger_source = 'oauth' AND trigger_session_id IS NOT NULL AND status IN ('pending', 'queued', 'running')`,
      ),
    nativeChatEventUnique: uniqueIndex('runs_native_chat_event_unique')
      .on(table.initiatorAgentId, table.triggerSource, table.triggerEventId)
      .where(sql`trigger_source IN ('slack', 'discord') AND trigger_event_id IS NOT NULL`),
    userIdIdx: index('runs_user_id_idx').on(table.userId),
    // Per-agent time series (GET /agents/:id/stats/timeseries): every query is
    // `initiator_agent_id = ? AND created_at BETWEEN ? AND ?`. The single-column
    // agent index above reaches the agent's rows but then needs a row lookup per
    // candidate to test the range, and the agent/session/status index cannot help
    // because trigger_session_id sits unconstrained in the middle of its key.
    initiatorAgentCreatedAtIdx: index('runs_initiator_agent_created_at_idx').on(
      table.initiatorAgentId,
      table.createdAt,
    ),
    statusCreatedAtIdx: index('runs_status_created_at_idx').on(table.status, table.createdAt),
    userIdCreatedAtIdx: index('runs_user_id_created_at_idx').on(table.userId, table.createdAt),
    // Data-retention sweep: WHERE status IN (terminal) AND updated_at < cutoff.
    statusUpdatedAtIdx: index('runs_status_updated_at_idx').on(table.status, table.updatedAt),
  }),
)

// ============================================================
// Chat Messages - conversation message records (isolated by cascade on runId)
// ============================================================
export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(), // msg_xxx
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Role: user | agent */
    role: text('role', { enum: ['user', 'agent'] }).notNull(),
    /** Message content */
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    runIdIdx: index('chat_messages_run_id_idx').on(table.runId),
  }),
)

// ============================================================
// Run Steps - run steps (isolated by cascade on runId)
// ============================================================
export const runSteps = sqliteTable(
  'run_steps',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id),
    /** Step sequence number */
    order: integer('order').notNull(),
    /** Input JSON */
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Output JSON */
    output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Status */
    status: text('status', { enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] })
      .notNull()
      .default('pending'),
    /** Duration in milliseconds */
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    runIdCreatedAtIdx: index('run_steps_run_id_created_at_idx').on(table.runId, table.createdAt),
    createdAtIdx: index('run_steps_created_at_idx').on(table.createdAt),
  }),
)

// ============================================================
// Attachment refs - attachment token → run reverse-lookup table
// ============================================================
/**
 * An indexable reverse-lookup table from token → runId. Attachment refs also live in
 * runSteps.input.attachments (for auditing), but that is a JSON blob, so looking up by token there
 * would require a full-table LIKE (no index, plus false matches from the `_` wildcard). Membership
 * authorization in GET /api/attachments/:token queries this table by exact token equality (the
 * token is indexed, O(log n)).
 *
 * Composite primary key (token, run_id): one staged token can be reused across several runs/agents,
 * and a member may preview it as long as they belong to the Agent of **any** run referencing it —
 * a single-token primary key would keep only the first run because of onConflictDoNothing, causing
 * a 403 for authorized members of subsequent runs. Rows are cascade-deleted with their run.
 */
export const attachmentRefs = sqliteTable(
  'attachment_refs',
  {
    /** Staging token (att_...). */
    token: text('token').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.runId] }),
    tokenIdx: index('attachment_refs_token_idx').on(table.token),
  }),
)

// ============================================================
// A2A Tasks - A2A protocol task persistence
// ============================================================
export const a2aTasks = sqliteTable(
  'a2a_tasks',
  {
    id: text('id').primaryKey(),
    /** The complete Task object, JSON-serialized */
    data: text('data').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  // Hourly cleanup does `DELETE ... WHERE updated_at < cutoff`; index it so that
  // sweep is a range scan instead of a full table scan.
  (table) => ({
    updatedAtIdx: index('a2a_tasks_updated_at_idx').on(table.updatedAt),
  }),
)

// ============================================================
// Feishu Pending Messages - Feishu message event persistence (a DB-backed fallback for the
// pending-job-registry)
// ----------------------------------------------------------------
// Entry: INSERT OR IGNORE at the start of handleMessage, DELETE after normal completion or
// failure.
// Startup recovery: scan the leftover rows and replay their payloads into handleMessage, so
// streaming card contexts can be rebuilt after a restart.
//
// The PK is (message_id, agent_id), NOT message_id alone. Feishu delivers the SAME message_id
// to every bot application in a chat, so when two a2wave Agents share a group each must own its
// own row. Under a message_id-only PK the second Agent's insert collided with the first, was
// swallowed as "duplicate delivery", and that Agent never answered; worse, whichever Agent
// finished first deleted the row by message_id and destroyed the other's restart-recovery
// record. Event-level idempotence is therefore per (message, agent) — which is the real unit
// of work — and every read/write of this table must filter on BOTH columns.
// ============================================================
export const feishuPendingMessages = sqliteTable(
  'feishu_pending_messages',
  {
    messageId: text('message_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Run id bound to this message (written after the runs insert; used during restart recovery to tell whether an active run already exists). */
    runId: text('run_id'),
    /** The complete raw event JSON: { message, sender } */
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.agentId] }),
    agentIdIdx: index('feishu_pending_messages_agent_id_idx').on(table.agentId),
  }),
)

// ============================================================
// Feishu Card Callbacks - interactive card callback records
// One row is written when a card is posted, and the button's callback value carries only that
// row's id; on receiving card.action.trigger the session association is looked up by id
// (anti-forgery / anti-replay / expiry), then redeemed once before resuming the same session.
// ============================================================
export const feishuCardCallbacks = sqliteTable(
  'feishu_card_callbacks',
  {
    id: text('id').primaryKey(), // fcb_xxx
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Links back to the original session (same origin as the run that posted the card); reused on resume */
    triggerSessionId: text('trigger_session_id').notNull(),
    /** Engine session id snapshotted when the card was posted (runs.result.chatId); used as payload.chatId to continue on resume */
    previousChatId: text('previous_chat_id'),
    /** Feishu chat id (open_chat_id), used for addressing/sending */
    chatId: text('chat_id').notNull(),
    /**
     * open_id of the user who triggered the card (= the card's recipient). On callback, the action
     * is allowed only when operator.open_id equals this value, preventing someone else in the
     * group from clicking on the trigger user's behalf. Empty means the restriction is not applied
     * (historical records / cases where it could not be obtained), for backward compatibility.
     */
    triggerOpenId: text('trigger_open_id'),
    /** chat_type of the original triggering message (p2p/group); restores the reply style on resume */
    chatType: text('chat_type'),
    /** thread_id of the original triggering message (topic group); restores topic replies on resume */
    threadId: text('thread_id'),
    /**
     * message_id of the very first question message (the quote-reply anchor). On continuation the
     * reply always hangs off this initial question rather than an intermediate card, which avoids
     * deeply nested reply chains in a group. When cards are chained, the same original question id
     * is passed through on every turn.
     */
    originalMessageId: text('original_message_id'),
    /** Interactive card declaration JSON (InteractiveCardSpec), used to echo labels and rebuild the in-place card update */
    spec: text('spec').notNull(),
    /** Debug info text suffix (generated from the operator's selections), appended at the bottom when rebuilding the in-place card update; empty = not shown */
    debugSuffix: text('debug_suffix'),
    /** Card message id backfilled after sending (open_message_id) */
    messageId: text('message_id'),
    /** pending = awaiting callback; used = already redeemed (prevents double clicks / replay) */
    status: text('status', { enum: ['pending', 'used'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
  },
  (table) => ({
    agentIdIdx: index('feishu_card_callbacks_agent_id_idx').on(table.agentId),
    expiresAtIdx: index('feishu_card_callbacks_expires_at_idx').on(table.expiresAt),
  }),
)

// ============================================================
// Artifacts - run artifacts (stored hierarchically by agentId/userHash/runId)
// ============================================================
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(), // art_xxx
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id),
    userId: text('user_id').references(() => users.id),
    filename: text('filename').notNull(),
    storagePath: text('storage_path').notNull(),
    // 'file' = a single file; 'directory' = an entire directory (a multi-file site, etc.), packed
    // into a zip on download
    kind: text('kind', { enum: ['file', 'directory'] })
      .notNull()
      .default('file'),
    mimeType: text('mime_type'),
    size: integer('size'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    runIdIdx: index('artifacts_run_id_idx').on(table.runId),
    userIdIdx: index('artifacts_user_id_idx').on(table.userId),
    expiresAtIdx: index('artifacts_expires_at_idx').on(table.expiresAt),
  }),
)

// ============================================================
// Artifact Shares - artifact share links (the id is the URL token; persisting it in the DB makes
// it revocable)
// ============================================================
export const artifactShares = sqliteTable(
  'artifact_shares',
  {
    id: text('id').primaryKey(), // shr_xxx, 96-bit base64url, used directly as /s/:shareId
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => users.id),
    /** public = anyone may view; password = a password is required; authenticated = login is required */
    accessLevel: text('access_level', {
      enum: ['public', 'password', 'authenticated'],
    }).notNull(),
    passwordHash: text('password_hash'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: integer('last_viewed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    artifactIdIdx: index('artifact_shares_artifact_id_idx').on(table.artifactId),
    expiresAtIdx: index('artifact_shares_expires_at_idx').on(table.expiresAt),
  }),
)

// ============================================================
// Settings - global settings (KV + category; globally shared, so no userId)
// ============================================================
export const settings = sqliteTable(
  'settings',
  {
    /** Category, e.g. 'general' */
    category: text('category').notNull(),
    /** Setting key, e.g. 'workspacePath' */
    key: text('key').notNull(),
    /** Setting value (stored as a string) */
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.category, table.key] }),
  }),
)

// ============================================================
// Agent Members - Agent collaborators (the owner is implicitly agents.userId; this table stores
// only viewer / editor)
// ============================================================
export const agentMembers = sqliteTable(
  'agent_members',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['viewer', 'editor'] })
      .notNull()
      .default('viewer'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.userId] }),
    userIdx: index('agent_members_user_id_idx').on(table.userId),
  }),
)

// ============================================================
// Evaluation Sets - a set of cases, owned by a single Agent
// ============================================================
export const evaluationSets = sqliteTable(
  'evaluation_sets',
  {
    id: text('id').primaryKey(), // evs_xxx
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    userId: text('user_id').references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdIdx: index('evaluation_sets_agent_id_idx').on(table.agentId),
  }),
)

// ============================================================
// Evaluation Cases - multi-turn request/reply pairs, isolated by cascade on setId
// ============================================================
export const evaluationCases = sqliteTable(
  'evaluation_cases',
  {
    id: text('id').primaryKey(), // evc_xxx
    setId: text('set_id')
      .notNull()
      .references(() => evaluationSets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Ordered turns: [{ request, expectedResponse }]; a single-turn case has length 1. */
    turns: text('turns', { mode: 'json' })
      .$type<{ request: string; expectedResponse: string }[]>()
      .notNull()
      .$defaultFn(() => []),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    setIdIdx: index('evaluation_cases_set_id_idx').on(table.setId),
    setSortIdx: index('evaluation_cases_set_sort_idx').on(table.setId, table.sortOrder),
  }),
)

// ============================================================
// Evaluation Tasks - one execution = one frozen config snapshot
// ============================================================
export const evaluationTasks = sqliteTable(
  'evaluation_tasks',
  {
    id: text('id').primaryKey(), // evt_xxx
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Set null on delete, so task history survives the removal of its set. */
    setId: text('set_id').references(() => evaluationSets.id, { onDelete: 'set null' }),
    /** Denormalised: still shows which set was run after that set is deleted. */
    setName: text('set_name').notNull(),
    name: text('name'),
    status: text('status', {
      enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    /**
     * When a cancel was requested. Persisted rather than held in memory: a task
     * can sit queued for minutes before it runs, and the process can restart
     * underneath it. An in-memory mark is lost in both cases, leaving the user's
     * cancel silently ineffective.
     */
    cancelRequestedAt: integer('cancel_requested_at', { mode: 'timestamp' }),
    /**
     * Config snapshot: provider + model + prompt. An explicit allowlist that
     * never contains credentials (apiKey / oauthToken / baseUrl) — snapshots are
     * stored long-term and are readable by every viewer.
     */
    configSnapshot: text('config_snapshot', { mode: 'json' })
      .$type<{
        providerId: string | null
        providerName: string | null
        model: string | null
        systemPrompt: string
        capturedAt: string
      }>()
      .notNull(),
    summary: text('summary', { mode: 'json' }).$type<{
      total: number
      passed: number
      failed: number
      unreviewed: number
      passRate: number | null
    }>(),
    error: text('error'),
    userId: text('user_id').references(() => users.id),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdCreatedAtIdx: index('evaluation_tasks_agent_id_created_at_idx').on(
      table.agentId,
      table.createdAt,
    ),
    statusIdx: index('evaluation_tasks_status_idx').on(table.status),
  }),
)

// ============================================================
// SCM Workload Leases - durable checkout-use reservations
// ============================================================
export const scmWorkloadLeases = sqliteTable(
  'scm_workload_leases',
  {
    /** Stable identity: `<workloadType>:<workloadId>`. */
    id: text('id').primaryKey(),
    workloadType: text('workload_type', { enum: ['run', 'evaluation'] }).notNull(),
    workloadId: text('workload_id').notNull(),
    /** The actual executing Agent, which may differ from a Run's initiator. */
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Binding snapshot reserved atomically with workload admission. */
    scmSourceId: text('scm_source_id')
      .notNull()
      .references(() => scmSources.id),
    /** Reserved work may be queued; active work owns a live process/cleanup lifecycle. */
    phase: text('phase', { enum: ['reserved', 'active'] })
      .notNull()
      .default('reserved'),
    /** Process instance responsible for releasing an active lease after cleanup. */
    ownerInstanceId: text('owner_instance_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workloadUnique: uniqueIndex('scm_workload_leases_workload_unique').on(
      table.workloadType,
      table.workloadId,
    ),
    agentIdIdx: index('scm_workload_leases_agent_id_idx').on(table.agentId),
    scmSourceIdIdx: index('scm_workload_leases_scm_source_id_idx').on(table.scmSourceId),
  }),
)

// ============================================================
// SCM Workspace Removals - durable worktree-removal reservations
// ============================================================
/**
 * A committed row means "this worktree is being removed right now". It is the
 * cross-replica counterpart of the workload lease: the lease says a workload
 * may be using a directory, this says a remover is about to delete one. Every
 * worktree creation path, run admission (for an explicitly named worktree),
 * path PATCH, source DELETE, and env bootstrap consults it; the two marks are
 * both written before their action under the SCM mutation lock, so any
 * interleaving sees at least one of them. SQLite clears leaked rows before it
 * starts listening after a restart. PostgreSQL retains an uncertain row: age
 * cannot prove that a peer's filesystem operation has stopped.
 */
export const scmWorkspaceRemovals = sqliteTable(
  'scm_workspace_removals',
  {
    /** Stable target identity: `<scmSourceId>:<workspaceName>`. */
    id: text('id').primaryKey(),
    scmSourceId: text('scm_source_id')
      .notNull()
      .references(() => scmSources.id),
    workspaceName: text('workspace_name').notNull(),
    /**
     * Process instance currently attempting the removal. NULL means the row was
     * explicitly handed off — its owner exhausted its bounded retries and left
     * the reservation for the reconciler to adopt. A non-NULL owner whose
     * heartbeat stopped is adopted the same way; only a beating owner's
     * reservation is left alone.
     */
    ownerInstanceId: text('owner_instance_id'),
    /** Opaque attempt fence; final release must match it to avoid ABA deletion. */
    attemptToken: text('attempt_token').notNull().default('legacy'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Refreshed on every adoption, so liveness is judged per attempt, not per target. */
    attemptStartedAt: integer('attempt_started_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    scmSourceIdIdx: index('scm_workspace_removals_scm_source_id_idx').on(table.scmSourceId),
    targetUnique: uniqueIndex('scm_workspace_removals_target_unique').on(
      table.scmSourceId,
      table.workspaceName,
    ),
  }),
)

// ============================================================
// Instance Heartbeats - process liveness for cross-replica recovery
// ============================================================
/**
 * One row per live API process, renewed on an interval. Liveness is what
 * durable SCM marks (workload leases, workspace-removal reservations) cannot
 * carry themselves: the age of a mark proves nothing — a multi-repository Git
 * operation can outlive any timeout — but a stopped heartbeat does prove its
 * owner is gone. `started_at` is this process's boot instant: instance ids are
 * reused across container restarts (HOSTNAME, a pinned A2WAVE_INSTANCE_ID), so
 * a mark written before its owner's current boot belongs to a dead previous
 * life even while the heartbeat looks fresh.
 */
export const instanceHeartbeats = sqliteTable('instance_heartbeats', {
  /** Process instance id (`processInstanceId`). */
  id: text('id').primaryKey(),
  /** Boot instant of the current life; overwritten when a reused id restarts. */
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  heartbeatAt: integer('heartbeat_at', { mode: 'timestamp' }).notNull(),
})

// ============================================================
// Evaluation Results - per-case execution result + manual review, isolated by cascade on taskId
// ============================================================
export const evaluationResults = sqliteTable(
  'evaluation_results',
  {
    id: text('id').primaryKey(), // evr_xxx
    taskId: text('task_id')
      .notNull()
      .references(() => evaluationTasks.id, { onDelete: 'cascade' }),
    /** Set null because the case may later be deleted; display falls back to the denormalised caseName. */
    caseId: text('case_id').references(() => evaluationCases.id, { onDelete: 'set null' }),
    caseName: text('case_name').notNull(),
    /** Snapshot of the case turns as they were at execution time. */
    turnsSnapshot: text('turns_snapshot', { mode: 'json' })
      .$type<{ request: string; expectedResponse: string }[]>()
      .notNull()
      .$defaultFn(() => []),
    /** Actual execution result: [{ request, expectedResponse, actualResponse, error?, durationMs? }] */
    actualTurns: text('actual_turns', { mode: 'json' }).$type<
      {
        request: string
        expectedResponse: string
        actualResponse: string | null
        error?: string | null
        durationMs?: number | null
      }[]
    >(),
    /** Manual review verdict: { verdict, note?, reviewedBy, reviewedAt } */
    review: text('review', { mode: 'json' }).$type<{
      verdict: 'pass' | 'fail' | 'unreviewed'
      note?: string | null
      reviewedBy: string
      reviewedAt: string
    }>(),
    /** Reserved for automatic scoring in v2; always null in v1. */
    score: text('score', { mode: 'json' }).$type<Record<string, unknown>>(),
    /**
     * `cancelled` marks a case the run never reached. Every terminal path of a
     * task settles its leftover rows, because a row left at `pending` has no
     * loop behind it any more and the detail page would render it as still
     * waiting under a task that already finished.
     */
    status: text('status', { enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] })
      .notNull()
      .default('pending'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    taskIdIdx: index('evaluation_results_task_id_idx').on(table.taskId),
    taskSortIdx: index('evaluation_results_task_sort_idx').on(table.taskId, table.sortOrder),
  }),
)

// ============================================================
// CLI Installations - runtime installation state of the Provider CLIs
// ============================================================
/**
 * Install state for the CLIs a2wave shells out to. The image ships no CLI (the
 * growing roster adds well over 1GB against a deployment that typically uses
 * one or two), so an admin installs them on demand and this table tracks that job.
 *
 * Keyed by a plain string rather than the `PROVIDER_KINDS` enum because not every
 * managed CLI is a Provider — CodeGraph is an SCM indexing tool with no Provider
 * record — and a foreign key to `providers` would exclude it.
 *
 * Whether a binary is actually present is always probed from PATH, never read
 * from here: a CLI can be installed into the persisted volume by one container
 * and removed outside a2wave entirely. This row records the *job*, so the UI can
 * show progress and the last failure instead of only a green/red dot.
 */
export const cliInstallations = sqliteTable('cli_installations', {
  /** Lock entry identity, e.g. 'claude-code' or 'codegraph'. */
  kind: text('kind').primaryKey(),
  /** Lifecycle of the most recent install job. */
  /**
   * Lifecycle of the most recent job. `installing` and `uninstalling` are both
   * *claims* on the same slot: install and uninstall for one kind are mutually
   * exclusive, and the claim is written synchronously at the request boundary so
   * a conflicting request is rejected rather than queued behind the running one.
   */
  status: text('status', { enum: ['idle', 'installing', 'uninstalling', 'error'] })
    .notNull()
    .default('idle'),
  /** Lock version this row last installed; null when never installed here. */
  installedVersion: text('installed_version'),
  /** Failure reason for the last attempt; cleared on success. */
  lastError: text('last_error'),
  /** Truncated installer output, for diagnosing a failure without shell access. */
  lastOutput: text('last_output'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// ============================================================
// Git trigger poll state (glab / gh channels)
// ============================================================
/**
 * Per-(agent, channel, repository) fingerprint of the last poll.
 *
 * Kept in its own table rather than inside `agents.glabConfig` for two reasons.
 * It is high-churn machine state written on every tick, so co-locating it with
 * user-authored config would make every poll rewrite the agent row and race
 * with a concurrent config edit — losing whichever write landed second. And it
 * must survive a restart: without persistence, every deploy would reset to a
 * cold start and either replay every open request or silently drop the events
 * that happened while the process was down.
 */
export const gitTriggerStates = sqliteTable(
  'git_trigger_states',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** 'glab' | 'gh' — one agent may watch both forges independently. */
    channel: text('channel', { enum: ['glab', 'gh'] }).notNull(),
    /** `host/project`, or `project` when using the CLI's default host. */
    repoKey: text('repo_key').notNull(),
    /** Observed merge/pull request fingerprints; see gitTriggerRepoStateSchema. */
    state: text('state', { mode: 'json' })
      .$type<z.infer<typeof gitTriggerRepoStateSchema>>()
      .notNull(),
    /**
     * Last poll failure for a repository that has succeeded at least once.
     *
     * Deliberately NOT written for a repository that never established a
     * baseline: inserting a row there would make the state read as a warm
     * baseline and replay every open request as new. So the most common kind of
     * persistent breakage (wrong path, not logged in) appears only in the logs.
     * Nothing reads this column yet — it exists for a future diagnostics
     * surface, which will need that gap closed some other way.
     */
    lastError: text('last_error'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.channel, table.repoKey] }),
  }),
)
