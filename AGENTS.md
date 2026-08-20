# a2wave — Project Guide

Natural-language-driven Agent orchestration: a general-purpose Agent building and orchestration platform for enterprises, published over API / Feishu / Slack / Discord / A2A / scheduled / chat page / GitLab & GitHub repository triggers.

**Primary language: English.** This is an OSS-facing repository — all code, comments, commit messages, documentation, and identifiers must be written in English.

**Trust model**: Agent authors and users are trusted colleagues; controls enforce accountability and least privilege, *not* containment of a hostile insider — never harden against a malicious authenticated author, and never skip auth, anonymous-invoke, drop an audit entry, or put credentials in `details`. Full statement: [trust model & Iron Rules](docs/agent/iron-rules.md) · [SECURITY.md](./SECURITY.md).

## Architecture

```
a2wave (pnpm monorepo)
├── apps/api/         # Hono + SQLite (Drizzle ORM) + Local Agent Execution
├── apps/web/         # React 19 + Vite + TailwindCSS v4 + Ant Design
├── apps/cli/         # CLI tool (a2wave command)
└── packages/shared/  # Zod schemas & types
```

Stack: TypeScript, Biome (lint), TanStack Query, React Router v7, Vitest + Playwright.

## Product boundary

Six **Iron Rules** define what a2wave will and will not build — check every new feature against them *first*: [docs/agent/iron-rules.md](docs/agent/iron-rules.md). Violations need maintainer sign-off before proceeding.

## Commands

```bash
pnpm install          # install
cp .env.example .env  # leave AUTH_SECRET empty — pnpm dev generates one
pnpm run dev          # API :3502 + Web :3501 (override with PORT / WEB_PORT)
pnpm stop             # free the ports if a previous run left orphans
pnpm test             # all unit/integration tests
pnpm db:migrate       # run migrations for the DATABASE_URL backend
```

Setup detail, database backends, worktree conventions: [docs/agent/development.md](docs/agent/development.md).

## Gates — non-negotiable, `--no-verify` forbidden

| Gate | Command | Bar |
|------|------|------|
| Lint | `pnpm lint` | 0 errors. Warnings are debt; an MR must add none |
| Typecheck | `pnpm typecheck` | Fully green, **test files included**. Use the root script, not bare `pnpm -r typecheck` |
| Test | `pnpm test` | All pass; changed code ships with tests |
| E2E (recovery / task-queue / Feishu) | `bash scripts/e2e/restart-recovery.sh` | 4/4 scenarios |

**TDD is mandatory** — Red → Green → Refactor; production code not validated by a failing test must never be committed. Never mask a typecheck error with `@ts-ignore` / `@ts-nocheck`. Full rules: [docs/agent/testing.md](docs/agent/testing.md).

## Guidelines

Read the topic doc before touching its area.

| Doc | Covers |
|---|---|
| [iron-rules.md](docs/agent/iron-rules.md) | Product identity, trust model, Iron Rules 1–6 |
| [core-concepts-notes.md](docs/agent/core-concepts-notes.md) | Agent / Provider / MCP / Skill / SCM / Run / Evaluation rules |
| [conventions.md](docs/agent/conventions.md) | ID prefixes, naming, imports, commits, doc/manual/audit sync, UI |
| [development.md](docs/agent/development.md) | Setup, SQLite vs PostgreSQL, git worktree conventions |
| [testing.md](docs/agent/testing.md) | TDD, gates, coverage thresholds, test utilities |
| [ci-pipeline.md](docs/agent/ci-pipeline.md) | CI jobs, husky hooks, architecture rules R1–R9 |
| [api-permissions.md](docs/agent/api-permissions.md) | Permission derivation, cross-cutting invariants, Evaluation, channels |
| [provider-cli.md](docs/agent/provider-cli.md) | Runtime CLI install, lock pins vs floors, min-version probing |
| [worktree-isolation.md](docs/agent/worktree-isolation.md) | Per-Agent worktrees, advance/pin rules, reclaim paths |
| [scm-storage-invariants.md](docs/agent/scm-storage-invariants.md) | Workspace arbitration, heartbeats, fail-stop |
| [git-trigger-channels.md](docs/agent/git-trigger-channels.md) | `glab` / `gh` polling, scopes, page budgets |
| [postgresql.md](docs/agent/postgresql.md) | PostgreSQL dialect guide |
| [design-tokens.md](docs/agent/design-tokens.md) · [i18n.md](docs/agent/i18n.md) | Design tokens / antd alignment; i18n conventions |
| [audit-logging.md](docs/agent/audit-logging.md) | `logAudit()` usage, action/resource copy |
| [e2e.md](docs/agent/e2e.md) · [e2e/AGENTS.md](e2e/AGENTS.md) | E2E environment, layout, fixtures |
| [oauth-channel.md](docs/agent/oauth-channel.md) · [cli-oauth.md](docs/agent/cli-oauth.md) · [cli-device-login.md](docs/agent/cli-device-login.md) · [cli-tokens.md](docs/agent/cli-tokens.md) | Auth methods, CLI OAuth, headless device login, CLI tokens |
| [run-channel-context.md](docs/agent/run-channel-context.md) · [a2a-task-lifecycle.md](docs/agent/a2a-task-lifecycle.md) | Call-context shape, A2A task lifecycle |
| [configuration.md](docs/agent/configuration.md) · [cli-install-publish.md](docs/agent/cli-install-publish.md) | Env configuration, CLI install/publish |
| [apps/api/AGENTS.md](apps/api/AGENTS.md) | Database operation rules, API-app conventions |
| [docs/PRODUCT.md](docs/PRODUCT.md) · [docs/core-concepts.md](docs/core-concepts.md) | Product vision; entity reference |

API endpoint list: `/api/docs` (Swagger UI) or [apps/api/src/openapi.ts](apps/api/src/openapi.ts).

**Important**: prefer the **Agents Team** approach — multi-agent decomposition and parallel execution for complex tasks.
