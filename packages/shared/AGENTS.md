# @a2wave/shared — Agent Guide

Global conventions live in the root [AGENTS.md](../../AGENTS.md).

The **single contract layer** across `apps/api` / `apps/web` / `apps/cli`: Zod schemas + inferred types define the data shapes and validation rules for the whole repo. Built with tsup into ESM + `.d.ts`. Dependencies are only `zod` (v4) and `croner`; consumed one-way by the apps, never depends on any app in reverse.

## Directory Structure

```
src/
├── index.ts            # barrel — the only public entry point; every new file must be re-exported here
├── schemas/            # one file per domain entity: Zod schema + inferred types
├── types.ts            # pure TS interfaces (no runtime validation): ApiResponse / ApiError / pagination
├── cron-utils.ts       # isSupportedScheduleCron + schedule examples (validated with croner)
├── memory-prompts.ts   # default prompt constants for auto-memory (worklog / insight)
└── __tests__/          # agent-schema / agent-member / cron-utils / memory-prompts
```

## Core Patterns (stated once, not repeated per file)

Every `schemas/*.ts` follows the same pattern; understand it before changing any schema:

- Entity schema (`z.object`) + `export type X = z.infer<typeof xSchema>` — **types are always inferred from schemas, never handwritten**.
- CRUD inputs: `createXInput` lists fields explicitly with `.default(...)`; when composing `updateXInput`, unwrap create-only defaults before `.partial()`. Zod 4 otherwise populates omitted PATCH fields with those defaults, which can silently overwrite existing data. Keep empty-patch and omitted-field regression coverage.
- Enums are exported separately as `z.enum([...])` (e.g. `runStatusEnum`, `publishChannelEnum`); the DB and frontend share the same set of values.
- `*_DEFAULTS` constants (e.g. `AGENT_DEFAULTS`, `MCP_SERVER_DEFAULTS`) are the **single source of default values for both the DB and Zod**; change defaults here.
- Date fields use `z.coerce.date()`; masking of sensitive fields is the responsibility of the api read paths (schemas do not mask).

Non-obvious points worth noting (the remaining files are self-explanatory by name):

- `agent.ts` — the largest and hottest schema, aggregating sub-configs for provider chain / Feishu / schedule / a2a / OAuth gateway, etc.; contains `@deprecated` inline provider fields (new code uses `providerId`). `createAgentInput` deliberately **excludes** `scheduleRunAsOwner` (see the NOTE in the file; identity can only be pinned via the publish route).
- `mcp-server.ts` — four transports (stdio/sse/http/group); the backend naming/uniqueness constraints of `groupConfig` live in the refine. Also exports `INTERNAL_MCP_NAMES` / `ADMIN_MCP_NAMES` for frontend filtering.
- `run-channel.ts` — `RunChannelContext` normalized across the five trigger channels (all fields snake_case, aligned with Feishu/IDaaS).
- `probe-models.ts` — the `(engineType, authMode)` matrix expresses required fields via a union.
- `feishuConfigSchema` uses `.passthrough()` to let legacy fields pass validation, deferring normalization to `normalizeFeishuConfig` on the api side.

## Contract Discipline (Iron Rule: changing a schema = changing a contract)

Schemas are cross-cutting contracts; any **new field / tightened validation / changed enum values / changed defaults** ripples downstream. Before changing anything, sweep the consumers:

- **apps/api** — route input validation, Drizzle table columns, masking/normalization logic, OpenAPI (`src/openapi.ts`). Tightening validation can make existing data fail on read.
- **apps/web** — hooks / forms / TanStack Query cache types (imported from `@a2wave/shared`).
- **apps/cli** — command inputs and output parsing.

For breaking changes (removing/renaming fields, changing enum values), prefer adding optional fields + defaults for backward compatibility; when compatibility is impossible, **update all three ends in the same MR** — never leave it half-done.

## Build First (common pitfall)

Downstream typecheck reads `dist/`, so **after changing a schema you must build before the change is visible**:

```bash
pnpm --filter @a2wave/shared build   # or dev --watch
```

The pre-push hook already runs this build automatically before `pnpm typecheck` (see the Testing section of the root [AGENTS.md](../../AGENTS.md)); when typechecking or integrating manually, build first yourself, or you will see false errors from stale types. Logic changes (`cron-utils` / `memory-prompts` / schema constraints) must come with `__tests__/` (`pnpm --filter @a2wave/shared test`).
