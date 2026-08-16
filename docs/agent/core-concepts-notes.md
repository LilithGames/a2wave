# Core Concepts — Platform Rules

Entity reference: [docs/core-concepts.md](../core-concepts.md). This file records
the rules that reading the entity list does not tell you.

Entities: Agent, Provider, MCP Server (stdio/sse/http/group), Skill, SCM Source,
Run, ChatMessage, Settings, Evaluation Set / Case / Task.

## Skill visibility

- Creator-private by default (`visibility = private`).
- Only an **administrator** may publish it as `all-users`, after which every
  signed-in user can discover and bind it while mutations remain owner/admin-only.
- Platform-seeded **built-in** Skills are system-owned and persist as `all-users`
  so every signed-in user can discover, bind, clone, and authenticated-export them.
- **Public share exports still omit all Skill content.**

## Provider

- A Provider must be able to **enumerate the models its bound credentials can
  run** — a hard onboarding condition, so `modelDiscovery` is `automatic` or
  `manual`, with no "unsupported" escape hatch. Providers therefore persist no
  model catalog and expose no editable field: the list is probed from the CLI per
  Agent credential and cannot drift from what the account really has. (`copilot`
  was retired under this rule — its CLI has no model-list command.)
- A Provider's **CLI is not preinstalled** — installed at runtime from
  `provider-cli-lock.json`, tracked in `cli_installations` (keyed by lock identity,
  not by Provider id, since a managed CLI need not be a Provider). See
  [provider-cli.md](./provider-cli.md).

## MCP Server

- Group type uses `groupConfig` (multi-backend progressive disclosure via proxy).
- Generic stdio and other `admin-only` MCP bindings remain usable through all
  approved execution channels while the Agent owner is an **active administrator**.
- The system-owned `a2wave-platform-admin` is **control-plane-only** and
  additionally requires an explicitly identified **active backend administrator**.
- Group backends follow the same runtime rule.

## Evaluation

An Evaluation Set groups Cases (each an ordered list of
`{request, expectedResponse}` turns); an Evaluation Task replays a set against the
Agent's current config and freezes a provider/model/reasoning-effort/fast-mode/prompt
snapshot for comparison — the two execution controls belong to the binding, so a task
that differed only in reasoning depth would otherwise be indistinguishable. Why it bypasses the `runs` table, its queueing and workspace
isolation: [api-permissions.md](./api-permissions.md#evaluation-why-it-bypasses-runs).

## Channels

- **Git repository trigger** (`glab` / `gh`) — see
  [git-trigger-channels.md](./git-trigger-channels.md).
- **Chat page** (`chat_app`) — publishes an Agent at `/agents/:agentId/chat_app`, a
  first-party page pairing the Agent's profile with a chat window. `chatAppConfig`
  holds **presentation copy only** (welcome message, suggested questions, display
  toggles), never credentials, so it needs no masking on read and round-trips
  through agent export/import intact.
