import { isIP } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { loadDotenvFiles } from './load-dotenv.js'

// Eagerly load `.env` into process.env *before* parsing the schema below.
// Extracted to load-dotenv.ts so operational CLIs (db:migrate) can read a raw
// variable without importing this module's validated env — see that file.
loadDotenvFiles()

const DEFAULT_AUTH_SECRET = 'dev-secret-change-me'
const MIN_AUTH_SECRET_LENGTH = 32
const DEFAULT_HOME_DIR = process.env.HOME?.trim() || homedir()

function isValidTrustedProxyAddress(value: string): boolean {
  if (isIP(value)) return true
  const [host, prefixRaw, ...rest] = value.split('/')
  if (!host || !prefixRaw || rest.length > 0) return false
  const version = isIP(host)
  if (!version) return false
  const prefix = Number(prefixRaw)
  if (!Number.isInteger(prefix)) return false
  return version === 4 ? prefix >= 0 && prefix <= 32 : prefix >= 0 && prefix <= 128
}

function hasValidTrustedProxyAddresses(raw: string): boolean {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return entries.every(isValidTrustedProxyAddress)
}

function hasValidExactHostnameAllowlist(raw: string): boolean {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return entries.every((entry) => {
    if (entry.includes('*') || isIP(entry)) return false
    try {
      const parsed = new URL(`https://${entry}`)
      return parsed.hostname === entry && parsed.host === entry && parsed.pathname === '/'
    } catch {
      return false
    }
  })
}

/**
 * Unified constructor for numeric env vars: first normalize an empty string to undefined, then
 * hand off to the inner coerce + default.
 *
 * .env.example ships `KEY=` (empty) for "leave blank to use the default" vars, and
 * docker-compose's `${VAR:-}` passthrough also yields '' when the host has not set a value.
 * z.coerce.number() reads an empty string as 0 (Number('') === 0) rather than undefined —
 * .default() does not take effect and the empty value is pinned to 0 (PORT=0, timeout=0 minutes),
 * or it hits .min(1) and crashes the process on startup. After preprocess normalizes '' to
 * undefined, the inner schema's coerce + default can fall back correctly.
 *
 * Only for operational numeric vars that follow "leave blank to use the default" (port, timeouts,
 * sync intervals). Security-sensitive numbers (e.g. AUTH_SESSION_TTL_DAYS) deliberately do NOT use
 * this — an empty string should fail loudly so operators immediately see the misconfiguration,
 * mirroring how AUTH_COOKIE_SECURE handles empty strings.
 */
function numberEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema)
}

/**
 * String twin of numberEnv: '' → undefined so `.default()` applies.
 *
 * .env.example ships `AUTH_SECRET=` / `CORS_ORIGIN=` (empty) and instructs
 * "cp .env.example .env". An empty string is not undefined, so without this
 * the default never applied — JWTs were signed with the empty string (which
 * also dodged the "still using default secret" startup warning) and
 * cors({origin: ''}) rejected every browser origin with no boot-time error.
 */
function stringEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema)
}

export const envSchema = z
  .object({
    PORT: numberEnv(z.coerce.number().default(3502)),
    HOST: z.string().default('0.0.0.0'),
    /**
     * SQLite file path (the default) or a `postgres://` / `postgresql://`
     * connection string. The scheme alone selects the backend — see db/dialect.ts.
     */
    DATABASE_URL: z.string().default('./data/a2wave.db'),
    /** Max PostgreSQL pool connections. Ignored on SQLite. */
    DATABASE_POOL_MAX: numberEnv(z.coerce.number().int().min(1).max(100).default(10)),
    // localhost (not 127.0.0.1) to match .env.example / README; browsers treat
    // them as distinct origins, and the docs tell users the default covers
    // http://localhost:3501.
    CORS_ORIGIN: stringEnv(z.string().default('http://localhost:3501')),
    /**
     * The instance's externally reachable origin, e.g. `https://a2wave.example.com`.
     *
     * Prerequisite for URL-form gateway JWT issuers: a standards-compliant
     * verifier derives the key location from `iss` (`{iss}/.well-known/jwks.json`),
     * so the instance must know its own public origin before it can advertise one.
     * Leave unset to keep the opaque `a2wave-<hex>` issuer path unchanged.
     *
     * Normalized to a bare origin with no trailing slash — derived URLs are built
     * by plain concatenation, and a stored slash would emit `//.well-known/...`,
     * which breaks the strict issuer matching gateways perform.
     */
    PUBLIC_URL: stringEnv(
      z
        .string()
        .default('')
        .superRefine((raw, ctx) => {
          if (raw === '') return
          let parsed: URL
          try {
            parsed = new URL(raw)
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'PUBLIC_URL must be an absolute URL, e.g. https://a2wave.example.com',
            })
            return
          }
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `PUBLIC_URL must use http or https, got ${parsed.protocol}`,
            })
          }
          // Reject anything beyond a pure origin: a path/query/fragment would make
          // `${PUBLIC_URL}/.well-known/...` land somewhere no gateway discovers.
          if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'PUBLIC_URL must be a bare origin without a path, query or fragment',
            })
          }
        })
        // Normalize through URL so the stored value is a canonical origin:
        // scheme/host lowercased and a default port dropped. `enable` compares
        // the issuer to this byte-for-byte, so `https://A2Wave.example.com`
        // would otherwise reject the matching lowercase issuer with a 400.
        .transform((raw) => {
          if (raw === '') return ''
          try {
            return new URL(raw).origin
          } catch {
            // Unreachable: superRefine above already rejected unparseable input.
            return raw.replace(/\/+$/, '')
          }
        }),
    ),
    /**
     * Mandatory outside NODE_ENV=test — see the superRefine below. A missing
     * .env (or an unfilled/whitespace-only `AUTH_SECRET=` line, normalized to
     * undefined here) fails startup with a setup hint instead of silently
     * running on a well-known secret. Tests keep a baked-in value so the suite
     * needs no env injection.
     */
    AUTH_SECRET: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().optional(),
    ),
    /** 浏览器 cookie 和 API/CLI bearer token 登录态有效期（天）；默认 1 天以保持旧部署 24h 行为。 */
    // Security-sensitive: session lifetime. Deliberately not numberEnv — an empty string should fail loudly (see the numberEnv comment).
    AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(1),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    /**
     * 显式控制 auth cookie 是否带 Secure + 是否走 __Host- 前缀。未设置时默认按 NODE_ENV
     * 推断（production = 安全，其它 = 兼容 HTTP）。NODE_ENV=production 但用户入口仍走
     * HTTP 的部署（内网、未加 HTTPS ingress 的私有部署）必须显式设为 'false'。
     *
     * 不容忍空串：docker-compose 的 `${VAR:-}` 透传若主机没设值会产生 ''，被静默回退
     * 到 NODE_ENV 推断会让生产 HTTP 入口意外切到 Secure=true（浏览器丢 cookie → 登录
     * 死循环）。fail-loud 反而能让运维立刻看见错配。
     */
    AUTH_COOKIE_SECURE: z.enum(['true', 'false']).optional(),

    // --- Provider CLI 运行时安装 ---
    /**
     * Provider CLI 的运行时安装根目录。镜像不预装任何 CLI（持续增长的 CLI 阵容
     * 总计远超 1GB，而单个部署通常只用一两个），由管理员在 UI 上按需安装到这里。
     * 容器内指向 /home/appuser/.a2wave（持久卷，非 root 可写）；
     * 本地开发默认落在仓库的 data/ 下，避免污染开发机的全局 npm 前缀。
     */
    A2WAVE_CLI_INSTALL_ROOT: z.string().default('./data/cli-root'),
    /** provider-cli-lock.json 所在目录（镜像里是 /app/provider-clis）。 */
    A2WAVE_CLI_LOCK_DIR: z.string().default(''),

    // --- Cursor Agent ---
    /** cursor-agent CLI 可执行文件路径 */
    CURSOR_AGENT_PATH: z.string().default('cursor-agent'),
    /** cursor-agent CLI 的 API Key */
    CURSOR_API_KEY: z.string().default(''),
    /** cursor-agent 执行超时（分钟） */
    CURSOR_AGENT_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** 是否启用 cursor-agent --force 模式（生产环境建议设为 false） */
    CURSOR_AGENT_FORCE: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    /** 是否自动批准 MCP 工具调用 */
    CURSOR_AGENT_APPROVE_MCPS: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),
    /** Agent 默认工作目录 */
    CURSOR_AGENT_WORK_DIR: z.string().default('./data/workspaces'),

    // --- Claude Code ---
    /** claude CLI 可执行文件路径 */
    CLAUDE_CODE_PATH: z.string().default('claude'),
    /** claude-code 认证 API Key（可选） */
    ANTHROPIC_API_KEY: z.string().default(''),
    /** claude-code 认证 Base URL（可选） */
    ANTHROPIC_BASE_URL: z.string().default(''),
    /** claude-code 执行超时（分钟） */
    CLAUDE_CODE_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** 是否启用 claude --dangerously-skip-permissions 模式（生产环境建议设为 false） */
    CLAUDE_CODE_FORCE: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    /** 是否自动批准 MCP 工具调用（通过 allowedTools 放行 mcp__*） */
    CLAUDE_CODE_APPROVE_MCPS: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),
    /** Agent 默认工作目录 */
    CLAUDE_CODE_WORK_DIR: z.string().default('./data/workspaces'),

    // --- Codex CLI ---
    /** codex CLI 可执行文件路径 */
    CODEX_PATH: z.string().default('codex'),
    /** Codex 认证 API Key（OpenAI 账号） */
    OPENAI_API_KEY: z.string().default(''),
    /** Codex 认证 API Key（官方 CI 备选 env 名） */
    CODEX_API_KEY: z.string().default(''),
    /** codex 执行超时（分钟） */
    CODEX_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** 是否启用 --dangerously-bypass-approvals-and-sandbox（生产环境建议设为 false） */
    CODEX_FORCE: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    /** 是否自动批准 MCP 工具调用（通过 --ask-for-approval never 放行） */
    CODEX_APPROVE_MCPS: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),
    /** Agent 默认工作目录 */
    CODEX_WORK_DIR: z.string().default('./data/workspaces'),

    // --- Qoder CLI ---
    /** qodercli executable path */
    QODER_PATH: z.string().default('qodercli'),
    /** Qoder Personal Access Token (deployment default; per-agent providerApiKey wins) */
    QODER_PERSONAL_ACCESS_TOKEN: z.string().default(''),
    /** qoder execution timeout (minutes) */
    QODER_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** Whether to pass --dangerously-skip-permissions (recommend false in production) */
    QODER_FORCE: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    /** Whether to auto-approve MCP tool calls (via --allowed-tools mcp__*) */
    QODER_APPROVE_MCPS: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),
    /** Default agent work directory */
    QODER_WORK_DIR: z.string().default('./data/workspaces'),

    // --- Trae CLI ---
    /** traecli executable path */
    TRAE_PATH: z.string().default('traecli'),
    /** Trae CLI login token (deployment default; per-agent providerApiKey wins) */
    TRAECLI_PERSONAL_ACCESS_TOKEN: z.string().default(''),
    /** Trae enterprise-dedicated host (optional, injected as TRAECLI_HOST) */
    TRAECLI_HOST: z.string().default(''),
    /** trae execution timeout (minutes) */
    TRAE_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** Whether to pass -y/--yolo to bypass tool permission checks (recommend false in production) */
    TRAE_FORCE: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    /** Whether to auto-approve MCP tool calls (via --allowed-tool mcp__*) */
    TRAE_APPROVE_MCPS: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),
    /** Default agent work directory */
    TRAE_WORK_DIR: z.string().default('./data/workspaces'),

    // --- Kimi Code CLI ---
    /** kimi executable path */
    KIMI_PATH: z.string().default('kimi'),
    /** kimi execution timeout (minutes) */
    KIMI_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** Default agent work directory */
    KIMI_WORK_DIR: z.string().default('./data/workspaces'),

    // --- Pi CLI ---
    /** pi executable path */
    PI_PATH: z.string().default('pi'),
    /** pi execution timeout (minutes) */
    PI_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** Default agent work directory */
    PI_WORK_DIR: z.string().default('./data/workspaces'),
    /** Optional deployment-level Pi agent directory (defaults to ~/.pi/agent) */
    PI_CODING_AGENT_DIR: stringEnv(z.string().min(1).optional()),

    // --- OpenCode CLI ---
    /** opencode CLI 可执行文件路径 */
    OPENCODE_PATH: z.string().default('opencode'),
    /** opencode 执行超时（分钟） */
    OPENCODE_TIMEOUT_MINUTES: numberEnv(z.coerce.number().default(10)),
    /** Agent 默认工作目录 */
    OPENCODE_WORK_DIR: z.string().default('./data/workspaces'),

    /** Skills 文件存储根目录（相对 cwd 或绝对路径） */
    A2WAVE_SKILLS_STORAGE: z.string().default('./data/skills'),
    /** 知识库文件存储根目录（相对 cwd 或绝对路径） */
    A2WAVE_KB_STORAGE: z.string().default('./data/kb'),
    /** Agent 长期记忆文件存储根目录（相对 cwd 或绝对路径） */
    A2WAVE_MEMORY_STORAGE: z.string().default('./data/memory'),

    /** Root for server-managed SCM checkouts and Git worktrees. */
    SCM_STORAGE_ROOT: stringEnv(
      z
        .string()
        .default(path.join(DEFAULT_HOME_DIR, '.a2wave'))
        .refine(path.isAbsolute, { message: 'SCM_STORAGE_ROOT must be an absolute path' }),
    ),

    /**
     * Comma-separated absolute roots under which custom SCM workspacesPath
     * values may be created. The built-in ~/.a2wave/workspaces root is always
     * allowed and does not need to be listed here.
     */
    SCM_WORKSPACES_ALLOWED_ROOTS: z
      .string()
      .default('')
      .refine(
        (raw) =>
          raw
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .every((entry) => path.isAbsolute(entry)),
        { message: 'SCM_WORKSPACES_ALLOWED_ROOTS entries must be absolute paths' },
      ),

    // --- Log rotation (production) ---
    /** 日志文件路径，默认 ./data/logs/current.log */
    LOG_FILE_PATH: z.string().default('./data/logs/current.log'),
    /** 生产环境是否启用日志轮转（单文件 20MB，最多 10 个） */
    LOG_ROTATE_ENABLED: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),

    // --- SSRF allowlists ---
    /** Exact import-source DNS hostnames allowed to resolve to controlled private addresses. */
    TRUSTED_IMPORT_HOSTS: z.string().default('').refine(hasValidExactHostnameAllowlist, {
      message: 'TRUSTED_IMPORT_HOSTS must contain exact DNS hostnames only',
    }),
    /** 逗号分隔的受信 Provider 主机名，允许模型探测连接其私网 DNS 地址 */
    TRUSTED_PROVIDER_HOSTS: z.string().default(''),
    /** Exact MCP DNS hostnames allowed to resolve to controlled private addresses. */
    TRUSTED_MCP_HOSTS: z.string().default('').refine(hasValidExactHostnameAllowlist, {
      message: 'TRUSTED_MCP_HOSTS must contain exact DNS hostnames only',
    }),
    /** Exact remote A2A DNS hostnames allowed in explicit public-only mode. */
    TRUSTED_A2A_ROUTE_HOSTS: z.string().default('').refine(hasValidExactHostnameAllowlist, {
      message: 'TRUSTED_A2A_ROUTE_HOSTS must contain exact DNS hostnames only',
    }),
    /**
     * Whether remote A2A routes may use ordinary private/CGNAT/ULA targets.
     * Defaults on for internal enterprise deployments. URL/DNS/redirect checks
     * and hard blocks for loopback, link-local, metadata, and reserved ranges
     * remain active. Set false to require public targets, with exact hostname
     * exceptions from TRUSTED_A2A_ROUTE_HOSTS.
     */
    ALLOW_PRIVATE_ROUTE_TARGETS: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('true'),
    /** 是否信任白名单反代传入的 X-Forwarded-For，用于认证限流分桶。 */
    TRUSTED_PROXY: z
      .string()
      .transform((v) => v === 'true' || v === '1')
      .default('false'),
    /** 逗号分隔的可信反代 TCP remoteAddress/IP CIDR。TRUSTED_PROXY=true 时才生效。 */
    TRUSTED_PROXY_ADDRESSES: z.string().default('').refine(hasValidTrustedProxyAddresses, {
      message:
        'TRUSTED_PROXY_ADDRESSES must be a comma-separated list of IP addresses or CIDR ranges',
    }),

    // --- Docker / 环境变量注入（可选，用于零交互部署）---
    /** 管理员初始密码（首次启动时自动设置，之后不再覆盖） */
    ADMIN_PASSWORD: z.string().optional().default(''),
    /** e2e 测试时禁用 dev 自动认证，以验证 401 行为 */
    E2E_STRICT_AUTH: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    /** P4 代码源 */
    SCM_P4_PORT: z.string().optional().default(''),
    SCM_P4_USER: z.string().optional().default(''),
    SCM_P4_PASSWD: z.string().optional().default(''),
    SCM_P4_CLIENT: z.string().optional().default(''),
    SCM_P4_DEPOT_PATH: z.string().optional().default(''),
    SCM_P4_LOCAL_PATH: z.string().optional().default(''),
    SCM_P4_AUTO_SYNC: z
      .string()
      .optional()
      .default('true')
      .transform((v) => v === 'true' || v === '1'),
    SCM_P4_SYNC_INTERVAL: numberEnv(z.coerce.number().min(1).optional().default(30)),
    /** Git 代码源 */
    SCM_GIT_REPO_URL: z.string().optional().default(''),
    SCM_GIT_BRANCH: z.string().optional().default('main'),
    SCM_GIT_USERNAME: z.string().optional().default(''),
    SCM_GIT_PAT: z.string().optional().default(''),
    SCM_GIT_LOCAL_PATH: z.string().optional().default(''),
    SCM_GIT_AUTO_SYNC: z
      .string()
      .optional()
      .default('true')
      .transform((v) => v === 'true' || v === '1'),
    SCM_GIT_SYNC_INTERVAL: numberEnv(z.coerce.number().min(1).optional().default(30)),
  })
  .superRefine((val, ctx) => {
    // NODE_ENV=test: the suite runs without env injection; keep a baked-in secret.
    if (val.NODE_ENV === 'test') {
      if (val.AUTH_SECRET === undefined) val.AUTH_SECRET = DEFAULT_AUTH_SECRET
      return
    }

    // Everywhere else AUTH_SECRET is mandatory: a missing .env must fail startup,
    // never silently run on a well-known default secret.
    if (val.AUTH_SECRET === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'AUTH_SECRET is required. Create a .env from the template (`cp .env.example .env`) ' +
          'and set AUTH_SECRET to a random string (`openssl rand -hex 32`), ' +
          'or export it in the environment (Docker/K8s).',
        path: ['AUTH_SECRET'],
      })
      return
    }

    // The historical default is rejected in every real environment (not just
    // production): accepting it in development would re-arm the no-token auth
    // bypass in auth-middleware, defeating the point of a mandatory secret.
    if (val.AUTH_SECRET === DEFAULT_AUTH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'AUTH_SECRET must not use the well-known default value — generate a real one (`openssl rand -hex 32`)',
        path: ['AUTH_SECRET'],
      })
    }

    if (val.NODE_ENV !== 'production') return

    if (val.AUTH_SECRET.length < MIN_AUTH_SECRET_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters in production`,
        path: ['AUTH_SECRET'],
      })
    }
  })
  // Narrow AUTH_SECRET back to string: the superRefine above guarantees it is
  // set on every success path (test default injected, otherwise validated).
  .transform((val) => ({ ...val, AUTH_SECRET: val.AUTH_SECRET as string }))

/** Render one `VAR: problem` line per Zod issue instead of a raw ZodError dump. */
export function formatEnvIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const key = issue.path.join('.') || '(env)'
    return `${key}: ${issue.message}`
  })
}

function parseEnvOrExit(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env)
  if (result.success) return result.data
  console.error('✗ Invalid environment configuration:')
  for (const line of formatEnvIssues(result.error)) {
    console.error(`  - ${line}`)
  }
  console.error(
    '  Fix the variables above in your shell or the monorepo-root .env (see .env.example).',
  )
  process.exit(1)
}

export const env = parseEnvOrExit()
