# Getting Started

This chapter walks you through the full "create → configure → publish → trigger → observe" loop in just a few minutes. Before you begin, keep one thing in mind: **a2wave is the orchestration layer and does not ship with a model of its own** — you must first configure a [Provider](/wiki/providers) (the underlying execution engine) before an Agent can actually run.

## Login

On a fresh deployment without `ADMIN_PASSWORD`, the first visit to the platform URL opens the setup
page: set the admin password there directly — no extra code to copy.

```bash
curl -X POST http://localhost:3502/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"password":"<STRONG_PASSWORD>","confirmPassword":"<STRONG_PASSWORD>"}'
```

> [!WARNING]
> Until the admin password is set, the setup endpoint is **unauthenticated** — whoever completes
> setup first becomes the administrator. Initialize immediately after deploying; if the instance is
> reachable by others, deploy with the `ADMIN_PASSWORD` environment variable to skip this window
> entirely.

- **Password login**: log in with the account set by the administrator during initialization (controlled by the system setting `passwordLoginEnabled`).
- **Enterprise SSO**: once an administrator configures **OIDC** or **SAML**, the matching sign-in button appears on the Web login page. The OAuth invocation channel reuses the OIDC configuration, while A2A uses the Agent's dedicated A2A API Key and does not accept that OIDC JWT.

Administrators can go to "Settings → Enterprise Login" to see the effective status of both methods and verify connectivity with each panel's "Test" button. The page only shows configuration status and a non-sensitive summary; it never displays key material.

> [!IMPORTANT]
> a2wave is an enterprise-grade platform: **anonymous invocation is not supported, and authentication is never skipped**.

## Five-Minute Quick Start

1. **Configure a Provider**: go to "Providers", pick one of the presets **Claude Code / Cursor CLI / Codex CLI / OpenCode CLI / Qoder CLI / Trae CLI / Kimi Code CLI / Pi CLI**. Credentials and models are configured on the Agent: enter credentials (API Key or OAuth, or use the server login session), then click "Fetch models" and pick one. See [Provider Execution Engine](/wiki/providers) for details.
2. **Create an Agent**: go to "Agents" → "New Agent", then choose "Blank" or a suitable scenario template. Templates prefill the name, prompt, and some safe defaults, but credentials remain empty; confirm the Provider, model, and required capabilities before saving.
3. **Mount capabilities (optional)**: as needed, mount [Skills](/wiki/skills), [MCP Servers](/wiki/mcp-servers), [SCM Sources](/wiki/scm-sources), and [Knowledge Bases](/wiki/knowledge-base); enable [Long-term Memory](/wiki/memory) if you need cross-session memory.
4. **Debug first**: use **Chat debugging** on the Agent detail page to verify that the prompt and capabilities work as expected, without exposing any external trigger.
5. **Configure a trigger and publish**: in the "Channels" area, choose one or more [Trigger Methods](/wiki/triggers) (API / Feishu / A2A / scheduled), then click **Publish**.
6. **Observe runs**: every trigger generates a Run; view its input, output, logs, and artifacts in [Runs](/wiki/runs).

## A Minimal Working Example

Goal: build an Agent that "replies whenever it receives a message" and invoke it via the API.

1. Configure the Claude Code Provider (enter the API Key, enable `claude-opus-4-8`).
2. Create an Agent "Echo Assistant" with the system prompt "You are a concise assistant; answer the user's question directly".
3. Check **API** as the publish channel, choose **API Key** for authentication, and after publishing, copy the Agent ID and API Key from the detail page.
4. Invoke it (see [Trigger Methods · API](/wiki/triggers) for details):

```bash
curl -X POST "https://<your-host>/api/gateway/<agentId>/invoke" \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","async":false}'
```

Returns `{"data":{"reply":"...","runId":"run_...","durationMs":1234}}`.

## Next

- Want to understand why the platform is designed this way → [Core Concepts & Architecture](/wiki/concepts)
- Want to configure Agents systematically → [Agent Management](/wiki/agents)
- Want to integrate Feishu / A2A / scheduled → [Trigger Methods](/wiki/triggers)
