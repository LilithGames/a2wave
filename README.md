<div align="center">

<img src="https://raw.githubusercontent.com/LilithGames/a2wave/main/apps/web/public/brand-icons/default.svg" alt="a2wave" width="72" height="72" />

# a2wave

**Turn the agent CLIs you already use into shared services your whole team can call.**

Describe an Agent in plain language, bind a model provider, publish it to Feishu,
Slack, Discord, an HTTP API, or a schedule. No flowcharts, no glue code.

[![CI](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml/badge.svg)](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[Core Concepts](./docs/core-concepts.md) · [Project Guide](./AGENTS.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

**English** | [简体中文](./README.zh-CN.md)

</div>

## What is a2wave?

a2wave turns the agent CLIs you already use — **Claude Code, Cursor Agent, OpenAI
Codex, and more** — into shared, governed services, reachable from Feishu, Slack,
Discord, an HTTP API, or a schedule.

Describe an Agent in natural language, bind a model provider, extend it with Skills
and MCP servers, publish. a2wave handles credential injection, run queueing, audit
trails, permissions, and delivery.

**a2wave orchestrates; it does not execute.** No bundled LLM inference, no sandbox
runtime, no drag-and-drop DAG editor — execution comes from the underlying CLIs, and
orchestration is written in natural language. These boundaries are enforced; see the
[Iron Rules](./AGENTS.md#product-identity--iron-rules).

### How it compares

|  | a2wave | Workflow builders (n8n, Dify, Flowise) | A bare agent CLI |
|---|---|---|---|
| **How logic is expressed** | Natural language | Nodes, edges, variable mapping | Natural language |
| **Who can run it** | Your whole team, via the channels they already use | Whoever opens the builder | Whoever has the terminal |
| **Model execution** | Your existing CLI + your credentials | Vendor-managed runtimes | Local only |
| **Governance** | Per-Agent permissions, audit trail, run queue | Varies | None |

Pick a2wave when your team already trusts an agent CLI and needs to *share* it — with
access control, an audit trail, and delivery into Feishu or Slack — rather than
rebuild its reasoning as a graph.

## Features

- 🤖 **Bring your own agent CLI** — Claude Code, Cursor Agent, OpenAI Codex,
  OpenCode, Qoder, Trae, Kimi and Pi are interchangeable execution engines,
  installed on demand from a pinned, checksum-verified lockfile.
- 🌊 **Publish to multiple channels** — one Agent, reachable via HTTP API, Feishu,
  Slack, Discord, A2A, schedules, GitLab / GitHub repository triggers, and a
  first-party chat page.
- 🧩 **Extend by composition** — add capabilities through Skills and MCP servers
  (stdio / SSE / HTTP / proxy groups) instead of forking the platform.
- 🔗 **Agent-to-agent calls** — Agents reach other Agents over A2A, including ones
  hosted outside your deployment.
- 📚 **Persistent memory** — per-Agent, with progressive disclosure and keyword,
  vector and hybrid search.
- 🧪 **Built-in evaluation** — replay curated case sets against an Agent's current
  config, with a frozen provider/model/prompt snapshot for honest comparison.
- 📦 **Git & Perforce workspaces** — Agents work on real checkouts, with isolated
  worktrees per evaluation run.
- 🔐 **Enterprise auth** — OIDC and SAML SSO, per-Agent owner/editor/viewer
  permissions, rate limiting, and an audit entry behind every write.

## Trust Model

a2wave is built for **internal enterprise teams**: Agent authors and Agent users are
assumed to be **trusted colleagues acting in good faith**.

That shapes the boundaries. Agents run CLIs with real capabilities — filesystem,
shell, injected credentials — *by design*. The platform does not sandbox authors from
each other, nor defend against an insider crafting a hostile Agent. Its controls
(authentication, per-Agent permissions, audit logging, rate limiting) enforce
**accountability and least privilege among teammates**, not containment of an
adversary already inside.

> [!IMPORTANT]
> Exposing a2wave to untrusted users or running untrusted Agent configurations is out
> of scope — add your own isolation layer. Full statement: [SECURITY.md](./SECURITY.md).

## Quick Start (Docker)

```bash
cp .env.example .env       # no edits needed
docker compose up -d --build
```

Visit **http://localhost:3502**. Then create an Agent, bind a model provider, and
publish it — the in-app manual at `/wiki` walks through the first one end to end.

> If `ADMIN_PASSWORD` is left empty, the first person to reach the setup page claims
> the admin account. Set it in `.env` to close that window.

> [!IMPORTANT]
> **On macOS**, add this to `.env` first — Docker Desktop reports bind mounts as
> root-owned, which the entrypoint refuses to adopt, so the container crash-loops
> without it.
>
> ```bash
> A2WAVE_WORKSPACE_DIR=$HOME/a2wave-workspace
> A2WAVE_RUN_AS_UID=10001
> A2WAVE_RUN_AS_GID=10001
> ```

Every setting has a working default; see [`.env.example`](./.env.example) for the
full list, and [Configuration](./docs/agent/configuration.md) for what each one does.

## Local Development

Requires **Node.js ≥ 22** (matching the image's `node:22-slim` runtime) and **pnpm ≥ 9**.

```bash
pnpm install
cp .env.example .env       # leave AUTH_SECRET empty; pnpm dev generates one
pnpm dev                   # API :3502 + Web :3501
pnpm stop                  # free the ports if a previous run left orphans
```

Development guides, API reference and database operations: [AGENTS.md](./AGENTS.md).
CLI install / upgrade / publish: [CLI Installation & Publishing](./docs/agent/cli-install-publish.md).

## Database Backend

`DATABASE_URL` alone picks the backend: a `postgres://` scheme means PostgreSQL,
anything else is a SQLite file path.

**SQLite (default, supported)** — nothing to configure; the Quick Start above gives
you one container with the database on a named volume.

**PostgreSQL ≥ 9.6 (experimental)** — start with the `postgres` profile, which adds
the bundled database container:

```bash
# PostgreSQL requires an explicit AUTH_SECRET. Append a generated value —
# do not paste the command itself as the value.
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave" >> .env

docker compose --profile postgres up -d
```

Migrations run on boot and pick the matching lineage; the API waits for the database
healthcheck, so a cold start is safe. The database port is not published to the host
— change `POSTGRES_PASSWORD` before using this outside a local trial.

> [!IMPORTANT]
> `postgres` in that URL is the **compose service name**, resolvable only on the
> compose network. Host-run commands (`pnpm dev`, `pnpm db:migrate`) read the same
> `.env` and will fail on it. To run containerised PostgreSQL and local SQLite side
> by side, keep `DATABASE_URL` out of `.env` and pass it per command — see
> [docs/agent/postgresql.md](./docs/agent/postgresql.md#running-docker-postgresql-alongside-a-local-sqlite-instance).

> [!WARNING]
> PostgreSQL is **experimental** and not recommended for production: it passes the
> full suite and a smoke test, but has no production soak time, and there is **no
> SQLite → PostgreSQL migration path** — switching starts from an empty database. It
> exists for multi-instance deployments, where one SQLite file cannot be shared
> safely. Details, including per-process cache caveats for replicas:
> [docs/agent/postgresql.md](./docs/agent/postgresql.md).

## Channels

A published Agent is reachable through HTTP API, Feishu, Slack, Discord, the A2A
protocol, scheduled triggers, GitLab / GitHub repository triggers, and the
first-party chat page.

> The Feishu channel supports Feishu (feishu.cn) apps; Lark international
> (larksuite.com) is not configurable yet.

## Documentation

| Document | Contents |
|------|------|
| [Core Concepts](./docs/core-concepts.md) | Agent, Provider, Skill, MCP Server, SCM Source, Run, Evaluation |
| [Configuration](./docs/agent/configuration.md) | Every environment variable and settings override |
| [Project Guide](./AGENTS.md) | Architecture, full API reference, testing strategy, conventions |
| [CLI Installation & Publishing](./docs/agent/cli-install-publish.md) | Installing, upgrading, and publishing the `a2wave` CLI |
| [Contributing](./CONTRIBUTING.md) | Dev setup, commit convention, quality gates, AI policy |
| [Security Policy](./SECURITY.md) | Trust model and vulnerability disclosure |

A running instance also serves an interactive API reference at `/api/docs` (Swagger
UI) and the user manual at `/wiki`.

## Built with AI

a2wave is built extensively with AI coding agents — a fitting way to build a platform
that orchestrates them. Every change lands through a full test pyramid (unit /
integration / E2E), hard lint and typecheck gates, and human review. AI-assisted
contributions are held to the same bar; see the
[AI Contribution Policy](./CONTRIBUTING.md#ai-contribution-policy).

## Contributing

Issues, discussions and pull requests are welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup, commit convention, quality gates and
the AI contribution policy. a2wave has explicit product boundaries (the Iron Rules in
[AGENTS.md](./AGENTS.md)); features that cross them need maintainer discussion first.
By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

> [!WARNING]
> Do **not** report security vulnerabilities through public issues or pull requests —
> follow [SECURITY.md](./SECURITY.md) to disclose privately.

## Contributors

Thanks to everyone who has contributed to a2wave!

<a href="https://github.com/LilithGames/a2wave/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LilithGames/a2wave" alt="a2wave contributors" />
</a>

## License

Licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Lilith Games — see
[NOTICE](./NOTICE) for attribution and bundled third-party material.
