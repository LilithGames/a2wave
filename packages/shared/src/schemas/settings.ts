import { z } from 'zod'

// ============================================================
// Single setting record (DB row)
// ============================================================
export const settingRecordSchema = z.object({
  category: z.string(),
  key: z.string(),
  value: z.string(),
})
export type SettingRecord = z.infer<typeof settingRecordSchema>

// ============================================================
// Grouped settings map — API response format
// { general: { workspacePath: '/tmp/...', timeoutMinutes: '15' } }
// ============================================================
export type SettingsMap = Record<string, Record<string, string>>

// ============================================================
// Update input — partial grouped object
// ============================================================
/**
 * Partial grouped update. `expectedVersions` is a **reserved top-level key**, not a
 * category: it carries the optimistic-concurrency map from `GET /settings`'s
 * `meta.versions`. Declaring it here documents the reserved name and stops a
 * category that happens to share it from being silently swallowed.
 */
export const updateSettingsInput = z
  .object({ expectedVersions: z.record(z.string(), z.string()).optional() })
  .catchall(z.record(z.string(), z.string()))
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>

// ============================================================
// Defaults — single source of truth
// ============================================================
export const SETTINGS_DEFAULTS: SettingsMap = {
  general: {
    teamName: 'a2wave',
    workspacePath: '/tmp/a2wave-sandbox',
    timeoutMinutes: '15',
  },
  branding: {
    subtitle: 'Agent 工作流',
    // Default brand icon: the original wave on a purple gradient background, matching the first
    // entry of the brand preset grid.
    faviconUrl: '/brand-icons/default.svg',
  },
  webhook: {
    enabled: 'false',
    type: 'feishu',
    url: '',
    maxRetries: '3',
  },
  artifacts: {
    storagePath: './data/artifacts',
    retentionHours: '168',
    publicBaseUrl: '',
    /**
     * Default 'false' makes GET /api/artifacts/:id/download a public capability
     * URL — anyone with the unguessable `art_<cuid>` id can fetch it, no login.
     * This is a deliberate shareable-link tradeoff for the trusted-internal-team
     * model (see root SECURITY.md), NOT an oversight: the id is random and the
     * path is traversal-guarded. Deployments that expose a2wave more broadly, or
     * whose artifacts are sensitive, should set this to 'true' (admin → Settings →
     * Artifacts), which enforces owner/admin auth on every download. Changing the
     * default is a product-boundary decision by the maintainers, not a bug fix.
     */
    requireAuthForDownload: 'false',
  },
  /**
   * Attachment (image/file) upload staging settings. Callers upload in two steps: POST
   * /api/attachments to obtain a token, then pass `attachments` in the invoke/chat body. The bytes
   * land in the staging area first and are copied into the runtime tmp directory at run time; the
   * staged copy is reclaimed by the TTL sweeper. Both the upload endpoint and the sweeper read the
   * limits/TTL from here rather than hardcoding them.
   */
  attachments: {
    /** Staging root directory (relative to cwd, or an absolute path). */
    stagingPath: './data/attachments',
    /** Hours to retain staged files (default 7 days); the sweeper reclaims staging directories
     * older than this. Historical image previews also depend on this window — once expired, only
     * the filename chip remains. */
    stagingTtlHours: '168',
    /** Per-file byte limit, default 10MB. */
    maxFileSizeBytes: '10485760',
    /** Maximum number of attachments carried by a single invoke. */
    maxFilesPerRequest: '10',
    /** Allowed extensions, comma-separated (no dot, lowercase). */
    allowedExtensions: 'png,jpg,jpeg,webp,gif,pdf,txt,md,csv,docx,xlsx',
  },
  /**
   * Evaluation execution settings. Evaluation tasks queue per Agent and do not
   * share slots with interactive chat runs: one evaluation task fans out into N
   * sequential Agent invocations, so it is far heavier than a single run, and
   * sharing agents.maxConcurrency would let a background batch starve
   * interactive conversations. That queue now runs one task at a time, so the
   * only key here is a retained no-op.
   */
  evaluation: {
    /**
     * @deprecated No longer read — evaluation runs strictly one task at a time
     * per Agent. Kept so existing databases keep a value they can be migrated
     * from, rather than dropping the row. See engine/evaluation-queue-db.ts.
     */
    maxConcurrency: '1',
  },
  /**
   * Time-based retention for the fast-growing history tables (runs + their
   * run_steps/chat_messages, audit_logs, evaluation results). Without this these
   * tables grow unbounded — the single SQLite file inflates, the page cache
   * thrashes, and every query slows down after a few months. A daily sweeper
   * deletes rows older than `retentionDays`; set `enabled: 'false'` to keep
   * everything forever (e.g. strict-audit deployments that archive externally).
   */
  dataRetention: {
    /** Master switch for the history retention sweeper. */
    enabled: 'true',
    /** Delete finished runs / audit logs / evaluation history older than N days. */
    retentionDays: '60',
  },
  /**
   * Provider prefill values for the Agent creation templates (all empty by default = no prefill,
   * falling back to the official API defaults). Enterprise deployments can point these at an
   * internal LLM gateway (an OpenAI-compatible proxy) address and default model, restoring the
   * out-of-the-box experience where a beginner template only needs one key pasted in.
   */
  templates: {
    /** Provider baseUrl prefilled by the template (gateway address for apiKey mode). */
    providerBaseUrl: '',
    /** Default model name prefilled by the template. */
    providerModel: '',
  },
  /**
   * SSO login method configuration (DB first, env as fallback). The three *Config keys store JSON
   * strings whose schemas live in schemas/sso.ts; when the DB config is complete it takes
   * precedence over the corresponding env vars as a whole. oidcClientSecretEnc is AES-GCM
   * ciphertext (key derived from AUTH_SECRET), written by the settings PATCH handler which
   * intercepts and encrypts the plaintext `sso.oidcClientSecret`; no read endpoint returns the
   * plaintext.
   */
  sso: {
    /** Standard OIDC config JSON; empty string = unconfigured (falls back to env A2WAVE_OIDC_*). */
    oidcConfig: '',
    /** OIDC client_secret ciphertext; empty string = unset (public client, or falling back to env). */
    oidcClientSecretEnc: '',
    /** SAML 2.0 config JSON; empty string = unconfigured (falls back to env A2WAVE_SAML_*). */
    samlConfig: '',
  },
  auth: {
    /** Master switch for OAuth / SSO (external JWT). When 'false', /api/auth/oauth/exchange returns 503 OAUTH_DISABLED_BY_ADMIN. */
    oauthEnabled: 'false',
    /** Allowed email domains, comma-separated (e.g. "example.com,corp.example.com"). Empty string = no restriction. */
    oauthAllowedEmailDomains: '',
    /** Default role for new users auto-provisioned via SSO; may only be 'user' or 'admin'. */
    oauthDefaultRole: 'user',
    /** When 'false', accounts are not created automatically; only existing local users may bind/log in via SSO. */
    oauthAutoProvision: 'true',
    /** When 'false', /api/auth/login returns 403 PASSWORD_LOGIN_DISABLED, forcing SSO for everyone. */
    passwordLoginEnabled: 'true',
  },
  /**
   * OpenTelemetry trace export of Agent runs to a single OTLP/HTTP endpoint (schemas/otel.ts).
   * headersEnc is AES-GCM ciphertext of a JSON header map, written by the settings PATCH handler
   * which intercepts and encrypts the plaintext `otel.headers`; no read endpoint returns values.
   */
  otel: {
    enabled: 'false',
    /** OTLP/HTTP base URL (`/v1/traces` is appended) or a full traces URL. */
    endpoint: '',
    headersEnc: '',
    /** When 'false', no prompt / response / tool argument / error text leaves the process. */
    captureContent: 'false',
    /** Overrides the `service.name` resource attribute; empty string = 'a2wave'. */
    serviceName: '',
  },
}
