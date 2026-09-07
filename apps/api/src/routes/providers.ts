import { PRESET_PROVIDERS, type ProviderListItem, probeModelsRequestSchema } from '@a2wave/shared'
import { asc, eq, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { agents, providers } from '../db/schema.js'
import { providerCatalog } from '../engine/index.js'
import { createId } from '../lib/id.js'
import { jsonArrayContainsKeyValue } from '../lib/json-sql.js'
import { logger } from '../lib/logger.js'
import { resolveProviderUrl, UnsafeUrlError } from '../lib/url-safety.js'
import { requireAdmin } from '../middleware/auth-middleware.js'
import { rateLimit } from '../middleware/rate-limit.js'

const app = new Hono()
const MASKED_SECRET = '********'
const probeModelsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyFn: (c) => String(c.get('userId' as never) ?? 'anonymous'),
})

type PersistedProvider = typeof providers.$inferSelect

function unsupportedProviderMessage(kind: string): string {
  return `No runtime adapter is registered for Provider kind "${kind}"`
}

function toProviderListItem(provider: PersistedProvider): ProviderListItem {
  const kind = String(provider.kind)
  if (providerCatalog.get(kind)) return providerCatalog.toProviderDto(provider)

  logger.warn(
    { providerId: provider.id, providerKind: kind },
    'Unsupported persisted Provider kind',
  )
  return {
    ...provider,
    kind,
    status: 'unsupported',
    diagnostic: {
      code: 'PROVIDER_KIND_UNSUPPORTED',
      message: unsupportedProviderMessage(kind),
    },
  }
}

function unsupportedProviderError(provider: PersistedProvider) {
  const providerKind = String(provider.kind)
  return {
    error: unsupportedProviderMessage(providerKind),
    code: 'PROVIDER_KIND_UNSUPPORTED' as const,
    details: { providerId: provider.id, providerKind },
  }
}

// --- Routes ---

/** GET / - list all providers (alphabetical by name, independent of seeding order) */
app.get('/', async (c) => {
  const all = await db.select().from(providers).orderBy(asc(providers.name))
  return c.json({ data: all.map(toProviderListItem) })
})

/**
 * GET /login-status/:engineType - inspect the Provider CLI's server-side login state.
 *
 * Used by the Agent configuration page to visualize localSession readiness.
 * The engineType path parameter is a compatibility alias for Provider.kind.
 * This route must be registered before /:id so the wildcard route cannot capture it.
 */
app.get('/login-status/:engineType', async (c) => {
  const engineType = c.req.param('engineType')
  const adapter = providerCatalog.get(engineType)
  if (!adapter) {
    return c.json({ error: `Unknown engine type: ${engineType}` }, 404)
  }
  if (typeof adapter.getEngine()?.checkLoginStatus !== 'function') {
    return c.json({ error: `Engine "${engineType}" does not support login-status detection` }, 501)
  }
  try {
    const status = await adapter.checkLoginStatus()
    return c.json({ data: status })
  } catch (e) {
    logger.warn({ err: e, engineType }, 'checkLoginStatus failed')
    // The engine's own "CLI not found" verdict has this exact shape, so the
    // failure is tagged: without it the config page reports a broken probe as a
    // missing CLI and sends the operator off installing something that is
    // already there.
    return c.json({
      data: {
        installed: false,
        loggedIn: false,
        error: e instanceof Error ? e.message : String(e),
        code: 'PROBE_FAILED',
      },
    })
  }
})

/**
 * POST /probe-models - discover model IDs for the current kind, auth mode, and credentials.
 *
 * The endpoint is stateless: credentials come from the body and are not read from the database,
 * so new or unsaved Agents can probe. The route only performs generic Zod validation and
 * ProviderAdapter dispatch; ProviderCatalog and the engine own capability, credential, and
 * protocol rules.
 *
 * This route must be registered before /:id so the wildcard route cannot capture it.
 */
app.post('/probe-models', probeModelsRateLimit, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (
    body &&
    typeof body === 'object' &&
    ['apiKey', 'oauthToken', 'baseUrl'].some(
      (field) => (body as Record<string, unknown>)[field] === MASKED_SECRET,
    )
  ) {
    return c.json(
      {
        data: {
          models: [],
          error: 'Saved credentials are masked. Re-enter them before fetching models.',
          code: 'masked_credentials',
        },
      },
      400,
    )
  }

  const parsed = probeModelsRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const req = parsed.data
  const adapter = providerCatalog.get(req.kind)
  if (!adapter) {
    return c.json({ error: `Unknown provider kind: ${req.kind}` }, 404)
  }

  const declaredFields = new Set(
    adapter.manifest?.capabilities.credentialFields[req.authMode]?.map(({ field }) => field) ?? [],
  )
  const unexpectedFields = (
    [
      ['apiKey', req.apiKey],
      ['oauthToken', req.oauthToken],
      ['baseUrl', req.baseUrl],
    ] as const
  )
    .filter(([field, value]) => value && !declaredFields.has(field))
    .map(([field]) => field)
  if (adapter.manifest && unexpectedFields.length > 0) {
    return c.json(
      {
        data: {
          models: [],
          error: `Credentials not supported for ${req.kind}/${req.authMode}: ${unexpectedFields.join(', ')}`,
          code: 'invalid_input',
        },
      },
      400,
    )
  }

  if (req.baseUrl) {
    try {
      await resolveProviderUrl(req.baseUrl)
    } catch (error) {
      const message =
        error instanceof UnsafeUrlError ? error.message : 'Provider baseUrl is not allowed'
      return c.json({ data: { models: [], error: message, code: 'invalid_input' } }, 400)
    }
  }

  // 派发到 engine（永远 resolve，不抛异常；错误以 result.error 表达）
  try {
    const result = await adapter.probeModels({
      authMode: req.authMode,
      ...(req.authHeaderStyle ? { authHeaderStyle: req.authHeaderStyle } : {}),
      ...(req.apiKey ? { apiKey: req.apiKey } : {}),
      ...(req.oauthToken ? { oauthToken: req.oauthToken } : {}),
      ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
    })

    if (result.error) {
      logger.warn(
        {
          providerKind: req.kind,
          authMode: req.authMode,
          code: result.code,
          error: result.error,
        },
        '[probe-models] failed',
      )
      // 用 502 表达 "上游/CLI 返回的失败"（区别于 400 校验错误）
      const status =
        result.code === 'unsupported_mode' || result.code === 'invalid_input' ? 400 : 502
      return c.json({ data: result }, status)
    }

    return c.json({ data: result })
  } catch (e) {
    logger.error(
      { err: e, providerKind: req.kind, authMode: req.authMode },
      '[probe-models] unexpected error',
    )
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

/** GET /:id - 获取单个 provider */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const provider = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0]
  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404)
  }
  if (!providerCatalog.get(String(provider.kind))) {
    return c.json(unsupportedProviderError(provider), 409)
  }
  return c.json({ data: providerCatalog.toProviderDto(provider) })
})

/**
 * PATCH /:id — gone on purpose.
 *
 * Every Provider field is now owned by code: identity/scripts/paths come from
 * PRESET_PROVIDERS and capabilities from the manifest, while the model catalog
 * is probed live from the CLI against the caller's credentials. Nothing is left
 * for an operator to edit, so the route would only ever be a way to write a
 * model list that disagrees with what the account can actually run.
 */
app.patch('/:id', requireAdmin, async (c) => {
  // Still resolve the id first: answering 403 for a Provider that does not exist
  // would tell a caller "not allowed" when the truth is "no such Provider", and
  // scripts that distinguish the two would mis-report.
  const { id } = c.req.param()
  const provider = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0]
  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404)
  }
  return c.json({ error: 'Providers are preset-owned and cannot be modified' }, 403)
})

/** GET /:id/dependents - 依赖此 provider 的 agents */
app.get('/:id/dependents', async (c) => {
  const { id } = c.req.param()
  const provider = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0]
  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404)
  }
  const dependentAgents = await (
    await db
      .select({
        id: agents.id,
        name: agents.name,
      })
      .from(agents)
      .where(
        or(
          eq(agents.providerId, id),
          // Dialect-neutral: `json_each` / `json_extract` are SQLite-only and
          // error outright on PostgreSQL, which would break provider dependency
          // lookup (and therefore the pre-delete check) on that backend.
          jsonArrayContainsKeyValue(agents.config, ['providerChain'], 'providerId', id),
        ),
      )
  ).map((agent) => ({ id: agent.id, name: agent.name }))
  return c.json({ data: { agents: dependentAgents } })
})

/** DELETE /:id - 删除 provider（预设 provider 不可删除） */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const provider = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0]
  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404)
  }
  return c.json({ error: 'Cannot delete a preset provider' }, 403)
})

// --- Seed preset providers ---

export async function seedPresetProviders() {
  for (const preset of PRESET_PROVIDERS) {
    const existing = (
      await db.select().from(providers).where(eq(providers.kind, preset.kind)).limit(1)
    )[0]

    if (!existing) {
      const id = createId('prv')
      await db.insert(providers).values({
        id,
        kind: preset.kind,
        name: preset.name,
        description: preset.description,
        initScript: preset.initScript,
        checkScript: preset.checkScript,
        skillsDir: preset.skillsDir ?? null,
        mcpConfigPath: preset.mcpConfigPath,
        isPreset: true,
      })
      logger.info(`Seeded preset provider: ${preset.name} (${id})`)
    } else {
      // Already present: refresh the preset-owned metadata. There is no model
      // catalog to preserve — models are probed from the CLI, never stored.
      await db
        .update(providers)
        .set({
          description: preset.description,
          initScript: preset.initScript,
          checkScript: preset.checkScript,
          skillsDir: preset.skillsDir ?? null,
          mcpConfigPath: preset.mcpConfigPath,
          updatedAt: new Date(),
        })
        .where(eq(providers.kind, preset.kind))
      logger.info(`Updated preset provider metadata: ${preset.name}`)
    }
  }
}

export default app
