# Provider Execution Engine

A Provider is the underlying execution engine behind an Agent, together with its credentials. a2wave itself does no reasoning — **all code execution and reasoning are delegated to the agent CLI corresponding to the Provider**. Without an available Provider, an Agent cannot run.

## Eight Preset Providers

The platform ships with eight non-deletable presets. Each preset has a stable kind; changing its display name does not change engine dispatch:

> [!IMPORTANT]
> **Being able to fetch a model list online is a hard requirement for a Provider.** Every Provider must be able to ask its CLI which models the credentials you bound can actually run. The platform therefore no longer maintains any hardcoded catalog — a hand-maintained list drifts from what the account can really use, letting you pick a model that only fails at run time.

| Provider | Underlying CLI | Skills Directory | MCP Config | Representative Models |
|----------|---------|------------|---------|---------|
| **Claude Code** | `claude-code` | `.claude/skills` | `.mcp.json` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| **Codex CLI** | `codex` | `.codex/skills` | Injected per run, not written to a file | `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.2-codex` |
| **Cursor CLI** | `cursor` | `.cursor/skills` | `.cursor/mcp.json` | `composer-1.5`, `opus-4.6`, `sonnet-4.5`, `gemini-3-pro`, `gpt-5.x-codex`, etc. |
| **OpenCode CLI** | `opencode` | `.opencode/skills` | Injected per run, not written to a file | Depends on the providers configured on the server (`provider/model` two-part format) |
| **Qoder CLI** | `qoder` | `.qoder/skills` | `.mcp.json` | `auto`, `ultimate`, `performance`, `efficient`, `lite` (the account's actual catalog can be fetched online) |
| **Trae CLI** | `trae` | `.traecli/skills` | `.trae/mcp.json` | Configured in the TRAE enterprise console, fetched online (e.g. `kimi-k2`, `doubao-seed` series) |
| **Kimi Code CLI** | `kimi` | `.kimi-code/skills` | `.kimi-code/mcp.json` | `kimi-code/k3`, `kimi-code/k3-256k`, `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed` (the account's actual catalog can be fetched online) |
| **Pi CLI** | `pi` | `.pi/skills` (passed explicitly per run) | Not supported by Pi's built-in runtime | localSession uses the providers configured for Pi; apiKey enumerates Pi's built-in `openai/*` models |

> Preset Providers are **entirely read-only**: names, scripts and paths are defined by the platform, capabilities by code, and the model catalog is fetched live on the Agent configuration page using that Agent's credentials. The Provider detail page keeps a single action — installing or updating the CLI behind it.

> [!NOTE]
> **Copilot CLI has been retired.** The GitHub Copilot CLI has no programmatic model-listing command, so it cannot meet the hard requirement above and could only be kept alive with a hardcoded catalog. On upgrade, Agents previously bound to it are unbound and their credentials cleared. If such an Agent has no other usable Provider left (none in its fallback chain either) and was **published**, it is automatically **stopped** — so it cannot keep receiving calls with no execution engine behind it. Pick another Provider, configure its model, and publish again to restore it.

## Install an Agent CLI (required on a new deployment)

A Provider is only configuration — the CLI behind it does the work. **The image preinstalls no CLI**: the eight supported CLIs together are well over 1GB while a deployment typically uses one or two, so bundling them all would grow the image with every CLI added. They are installed on demand instead.

> [!IMPORTANT]
> On a fresh deployment, or after upgrading the image, install the CLIs this deployment actually uses first — otherwise Agents bound to that Provider cannot run.

**How to install** (admin required):

1. Open the **Providers** page. Each card shows whether that Provider's CLI is installed, with an Install button right there when it is not.
2. The install runs in the background and the status refreshes on its own — no need to stay on the page.
3. Open a Provider to see its detail page, where the **Agent CLI** card carries the fuller picture: binary name, pinned version, current version, the last failure, and Uninstall.

Installs use the platform's **pinned versions** with integrity verification, so there is no field for installing an arbitrary version — bumping a CLI is handled by whoever maintains the platform.

> [!TIP]
> Installed CLIs live on a persistent volume and **survive an image upgrade**, so this is not a per-deploy chore. `docker compose down -v` deletes them along with the volume, and they must then be reinstalled.

To reclaim disk space for a CLI you no longer need, use Uninstall on that Provider's **Agent CLI** card.

> [!TIP]
> Where the pinned version cannot be installed or upgraded — an internal network, an air-gapped host, an IT-managed machine — point a2wave at a binary the machine already has instead, by setting the matching environment variable on the service process. That bypasses the platform's own install flow.
>
> `CLAUDE_CODE_PATH`, `CODEX_PATH`, `CURSOR_AGENT_PATH`, `OPENCODE_PATH`, `QODER_PATH`, `KIMI_PATH`, `PI_PATH`, `TRAE_PATH`
>
> Left unset, each resolves its binary name (`claude`, `qodercli`, …) on `PATH`. This is what the diagnosis means when an upgrade hint offers to "point the deployment at another binary".

> [!NOTE]
> The pinned version is an **exact** version, not a minimum. If the CLI installed on the server is *newer* than the pin, the status reads "Unmanaged version" rather than prompting an update — it usually works fine, it simply is not the build the platform verified. The button then reads "Reinstall pinned version", and using it **replaces the build with the pinned one**, which may be a downgrade.
>
> For a version *older* than the pin, what you see depends on the Provider's **minimum version requirement** (see the note on minimum versions further down this section): a build that still meets it reads "Older than pinned" and runs normally, so updating is optional; only a build below the minimum reads "Below minimum" in amber, and its button hint names the version required. Either way, "Update" installs the pinned build.

> [!CAUTION]
> After upgrading an older database, the Providers page may report an unsupported historical Provider. The record remains visible for diagnosis but is excluded from Agent selection, and any Agent still bound to it is rejected with an Agent configuration error. Back up the database, then ask the platform administrator to migrate or remove the historical record before retrying.

> [!NOTE]
> Some Providers have a **minimum CLI version requirement** on the server (Qoder CLI ≥ 1.0.0, Trae CLI ≥ 0.120.0, OpenCode CLI ≥ 1.18.0, Kimi Code CLI ≥ 0.30.0, Pi CLI ≥ 0.83.0). This is a floor, not an exact version — a newer CLI is fine. Login-status checks report the installed version and flag one below the requirement, and the comprehensive diagnosis on any Agent bound to that Provider raises an error-level check naming the installed version and the minimum. Model fetching and login detection may be unavailable on older versions, though the platform does not block runs because of it. The platform's pinned versions all satisfy these requirements.

## Credential Mode (authMode)

Choose the credential injection method on the Agent that references the Provider:

- **apiKey**: injects an API Key (e.g. `ANTHROPIC_API_KEY` or the equivalent for each CLI; for Qoder this is a Personal Access Token, for Trae a CLI login token generated in the enterprise console). Codex and Pi also accept an optional per-Agent Base URL for an OpenAI-compatible proxy.
- **oauth**: injects `CLAUDE_CODE_OAUTH_TOKEN` (only effective for Claude Code).
- **localSession**: uses the deployment-level shared CLI session in the **server or container running a2wave** (**not the computer where your browser is open**) and injects no credentials. All Agents selecting localSession for the same Provider share this identity.

Claude Code apiKey mode has an explicit **API Key header** choice; a2wave does not infer authentication from the Key prefix:

- **x-api-key (compatible default)**: uses `ANTHROPIC_API_KEY` / `x-api-key` and preserves the configured Base URL at execution time. Existing configurations and configurations without this saved field retain this behavior, regardless of whether the Key starts with `sk-`.
- **Authorization: Bearer (proxy token)**: uses `ANTHROPIC_AUTH_TOKEN` / Bearer authentication. For execution only, a trailing `/v1` is removed from the Base URL.

Codex apiKey mode accepts an optional **Base URL**. a2wave passes it through Codex's official `openai_base_url` runtime setting; leaving it empty uses Codex's default OpenAI endpoint. localSession mode ignores an Agent-saved API Key and Base URL so the deployment login remains authoritative.

> [!NOTE]
> Saved Keys, tokens, and Base URLs returned by the API are masked. Model discovery is stateless, so re-enter every masked field before clicking "Test connection & fetch models"; otherwise the UI asks for the value instead of sending `********` as a real credential.

For Providers whose CLI model command calls the configured gateway, "Test connection & fetch models" requires that gateway to expose its model catalog. Codex and Pi are exceptions: their CLIs enumerate built-in models without contacting the configured proxy, so a successful model fetch confirms the CLI catalog shape but does not validate the Key or Base URL. The first execution remains the definitive connectivity check.

### localSession in Docker

`docker-compose.yml` keeps `/home/appuser`, the CLI user home, in the persistent `a2wave-cli-home` volume. Rebuilding the image, recreating the container, or running `docker compose down` keeps the sessions. They are removed only when you explicitly run `docker compose down -v`, delete the volume, or clear the credential directory.

Except for Claude Code, log in inside the container as the a2wave service user:

```bash
docker compose exec -u appuser a2wave qodercli login
```

Replace the last command for each CLI:

| Provider | Login command | Default persistent location |
|----------|---------------|-----------------------------|
| Claude Code | `claude login` | `~/.claude` |
| Codex | `codex login` | `~/.codex` |
| Cursor | `cursor-agent login` | `~/.cursor` |
| OpenCode | `opencode auth login` | `~/.local/share/opencode`, `~/.config/opencode` |
| Qoder | `qodercli login` | `~/.qoder` |
| Trae | `traecli` | `~/.trae` |
| Kimi Code | `kimi login` | `~/.kimi-code` |
| Pi | Run `pi`, then `/login` | `~/.pi/agent` |

> [!NOTE]
> For compatibility with existing deployments, Compose still mounts host `${HOME}/.claude` read-only into the container. Log in to Claude Code on the host; when Docker is started via sudo/systemd, set `A2WAVE_CLAUDE_LOGIN_DIR` in `.env` to the actual logged-in directory. Other Providers use `a2wave-cli-home` by default.

> [!CAUTION]
> localSession is a deployment-level shared identity, not an Agent-specific identity. Use the Provider's apiKey mode when different Agents need different accounts.

### OpenCode's Peculiarity

OpenCode is an open-source multi-provider aggregation CLI — you configure the access and credentials of each model provider (Anthropic / OpenAI / self-hosted proxy, etc.) yourself on the server, so within a2wave it **only supports localSession mode**:

- Both credentials and provider definitions live on the **server running a2wave**, maintained by the administrator via `opencode auth login` and OpenCode config files, and are a **deployment-level shared account** — all Agents using OpenCode share this one configuration.
- The model list is pulled automatically from the server, with model IDs in the `provider/model` two-part format (e.g. `anthropic/claude-opus-4-8`); the available options depend on which providers are configured on the server.
- Mounted MCP Servers and Skills are injected automatically by the platform on each run, with no manual configuration needed on the OpenCode side.

> [!NOTE]
> If Agents need independent credentials each, choose Claude Code / Codex / Cursor / Qoder / Trae / Pi and use apiKey mode. OpenCode and Kimi Code suit the scenario of "a unified set of models configured on the server, shared by all Agents"; Pi can use either pattern.

### Qoder and Trae

- **Qoder CLI**: a Claude-Code-compatible agent CLI. In apiKey mode, enter a **Personal Access Token** (generated on the qoder.com account "Integrations" page, shown only once); or use the server's `qodercli login` session. Models come in tiers such as `auto` / `ultimate`; click "Fetch models" to get the actual catalog for your account.
- **Trae CLI**: ByteDance TRAE's enterprise CLI, **available to TRAE CN enterprise Ultimate accounts only**. In apiKey mode, enter a **CLI login token** (`trae-lt-...`, with an expiry) generated on the enterprise console's "Access Tokens" page; fill in the "Enterprise host" field if your company has a dedicated domain. The available models are decided by the enterprise console; click "Fetch models" to retrieve them online.

### Kimi Code

- **Kimi Code CLI**: Moonshot AI's agent CLI (`kimi`), which **only supports localSession mode**:
  - Sign in on the server with `kimi login`, a device-code flow: the command prints a verification URL and a code, and you approve it in a browser. Credentials are stored under `~/.kimi-code/credentials/`.
  - Kimi Code **deliberately does not read API keys from environment variables** (they would have to be written into its own `config.toml`), so there is no apiKey or oauth mode to choose — like OpenCode, the server login is a **deployment-level shared identity** for every Agent using this Provider.
  - Models are the aliases configured for that account (e.g. `kimi-code/k3`); click "Fetch models" to retrieve the live catalog.
  - Mounted Skills and MCP Servers are written into the workspace automatically (`.kimi-code/skills` and `.kimi-code/mcp.json`) — nothing to configure on the Kimi side.
  - Non-interactive runs always use Kimi's `auto` approval policy, so the Agent's "read-only / force / auto-approve MCP" execution options do not apply and are hidden.

> [!NOTE]
> Kimi Code does not report token usage in its output, so runs using it show 0 tokens. See [Run Records](/wiki/runs).

### Pi

- **Pi CLI** (`@earendil-works/pi-coding-agent`) is a minimal open-source, multi-provider coding agent. a2wave supports two credential modes:
  - **localSession** (the compatible default): on the server or inside the container, run `pi`, enter `/login`, and configure the providers the deployment should use. Pi stores its login/config state under `~/.pi/agent` by default. This is a **deployment-level shared identity** for every Agent bound to Pi. Click "Fetch models" to read Pi's live `--list-models` catalog.
  - **apiKey**: enter an Agent-specific Key and an optional OpenAI-compatible Base URL. "Fetch models" runs Pi's own offline `--list-models openai` command and offers the built-in `openai/*` models it reports. This does not call the proxy's `/models` endpoint or validate the Key; actual execution is the connectivity check. Custom model IDs absent from Pi's CLI catalog cannot be selected in this mode.
  - For each apiKey probe and run, a2wave creates a private, temporary Pi `models.json` override for the built-in `openai` provider. The file refers to the Key through an isolated child-process environment variable; the real Key is not placed in command arguments or logs. The temporary directory is removed afterward and the deployment's `~/.pi/agent` configuration is never changed.
  - a2wave writes selected Skills to `.pi/skills` and passes that directory explicitly on each run. Pi's global/project Skills and Extensions are disabled for headless a2wave runs, so only reviewed Agent-mounted Skills are loaded.
  - Pi deliberately ships with **no built-in MCP client**. When an Agent combines Pi (including as an enabled fallback) with mounted MCP Servers or A2A routes, the Config tab flags the conflict immediately. Saving the conflict to an already published Agent, publishing, or resuming rejects it before changing the live configuration, publish state, or channels, instead of silently running without those tools. Configuration remains editable while the Agent is a draft or stopped so its owner can remove the MCP-backed capabilities or choose another Provider. If an existing published Agent is rejected, stop it, remove the MCP-backed capabilities or switch Provider, save the repaired configuration, and then resume it. An upstream Pi extension can add MCP, but a2wave does not silently install or trust such an extension.
  - Pi exposes only the **read-only** execution option in a2wave. When enabled, the run is limited to Pi's `read`, `grep`, `find`, and `ls` built-in tools. Pi does not provide an OS-level sandbox.
  - localSession runs inherit the server service user's HOME, so `/login` and provider credentials that depend on a user directory, such as AWS profiles or Google ADC, stay consistent between model discovery and execution. Session files remain isolated per Agent in both modes. Follow-ups in the same workspace resume that session; switching worktrees forks the existing context into the selected worktree and returns a new session ID. If local session persistence is missing, a2wave records a warning and lets Pi create an empty conversation under the original session ID. The current chat remains usable, but the missing context cannot be recovered.

> [!NOTE]
> Each Pi assistant event reports usage for one provider call, while automatic compaction reports a separate summarization call. a2wave accumulates those official input/output/reasoning/cache fields and separates reasoning from output to avoid counting Pi's reasoning subset twice. See [Run Records](/wiki/runs).

## Configuring a Provider

Credentials and models are configured on the **Agent**, not on the Provider — one Provider can be used by many Agents under different accounts, and the available models differ per account.

1. Open the Agent you want to configure and go to the Provider block on its "Configuration" tab.
2. Pick a Provider and enter credentials (API Key / OAuth), or confirm using the server login session.
3. Click "Fetch models" (some Providers fetch automatically once credentials are ready) and pick a model from the returned list.
4. Save.

> [!CAUTION]
> A Codex Base URL is a credential boundary. Configure its API Key in the same Agent binding; a2wave refuses to combine an Agent-controlled URL with the deployment-level Codex key. Pi apiKey mode likewise requires its Key in the Agent binding. Incomplete bindings are rejected before publish, resume, or a live configuration update takes effect.

> [!TIP]
> Every entry in the model dropdown is a model **those credentials can currently actually run**. Switching Provider or changing credentials invalidates the list, so fetch it again.

Administrators who need to install or update the CLI behind a Provider can do so on "Providers" → the Provider's detail page.

### Using an internal Provider endpoint

When you click "Test connection & fetch models", a2wave resolves the Base URL and rejects private or reserved addresses by default so the endpoint cannot be used to access the server's internal network. If your enterprise model gateway is available only through private DNS, ask the deployment administrator to add its exact hostname to `.env` and restart the service:

```dotenv
TRUSTED_PROVIDER_HOSTS=llm-proxy.internal.example.com,trae.internal.example.com
```

Enter hostnames only—do not include `https://`, a port, a path, or wildcards. The allowlist permits ordinary enterprise-private DNS answers (private IPv4/CGNAT and IPv6 ULA); private IP literals, loopback, multicast, and other reserved addresses remain blocked. Cloud metadata endpoints such as `169.254.169.254`, Alibaba Cloud `100.100.100.200`, AWS IPv6 `fd00:ec2::254`, and their mapped/NAT64/6to4 forms are hard-blocked even for an allowlisted hostname.

Claude Code OAuth and server-session model discovery always connects to the fixed `https://api.anthropic.com/v1/models` endpoint. a2wave permits ordinary enterprise-private DNS answers only for that non-user-controlled request, without requiring `TRUSTED_PROVIDER_HOSTS`; the same forbidden address ranges remain blocked. A custom Provider Base URL using `api.anthropic.com` does not inherit this exception.

> [!CAUTION]
> Trust is matched by hostname, not by the complete URL: once matched, HTTP(S) ports and paths on that hostname are within the trust boundary. Add only dedicated, enterprise-controlled Provider gateway hostnames—never a shared hostname serving other sensitive systems or a domain whose DNS answers users can control.

> [!NOTE]
> Claude Code model discovery pins the validated address at the connection layer. Providers such as Trae, whose CLI subprocess owns the network connection, can only be DNS-validated before launch; a2wave cannot pin the subprocess connection. Continue to enforce the expected gateway with managed DNS and outbound network policy.

## Viewing Dependents and Deleting

- Each Provider's detail page lets you view the **list of Agents that depend on it** (`GET /api/providers/:id/dependents`).
- Before deleting, confirm no Agent is using it, otherwise the execution of published Agents will be affected.

## Troubleshooting

| Symptom | Possible Cause | Fix |
|------|---------|------|
| Agent fails immediately with "CLI not installed" | The image preinstalls no CLI and this Provider's CLI is missing | Install it from that Provider's card on the **Providers** page |
| Agents stop working after an image upgrade | The persistent volume was deleted (e.g. `docker compose down -v`) | Reinstall from the **Providers** page |
| Install fails with a verification error | Network issue, or the download was altered by a proxy | Open the Provider's detail page and check the error on the **Agent CLI** card, then retry; an intranet must be able to reach the npm registry and each CLI's download host |
| Status reads "Unmanaged version" | The CLI on the server is newer than the platform's pinned version | Usually fine to keep; to match the verified build, use "Reinstall pinned version" |
| Status reads "Older than pinned" | The CLI is older than the pin but still meets this Provider's minimum version requirement | Nothing to do — it runs normally; use "Update" only if you want the build the platform verified |
| Agent model dropdown is empty | Models not fetched yet, or the credentials are invalid | Enter credentials on the Agent configuration page, then click "Fetch models" |
| Authentication failure on execution | API Key/Token expired or left blank | Re-enter credentials; or switch to localSession |
| OAuth not taking effect | oauth used on a non-Claude Code | oauth is only supported by Claude Code |
| Model fetch for a custom Base URL reports `private or reserved address` and suggests `TRUSTED_PROVIDER_HOSTS` | The Provider hostname resolves to an ordinary private address from the a2wave server | After confirming the endpoint is trusted, have the deployment administrator add the exact hostname to `TRUSTED_PROVIDER_HOSTS` and restart the service |
| Claude Code OAuth model fetch reports `private or reserved address` | Server DNS maps the fixed `api.anthropic.com` upstream to a forbidden loopback, link-local/metadata, multicast, or reserved range | Correct the server DNS or outbound proxy; the fixed OAuth discovery request already permits ordinary private DNS answers, and `TRUSTED_PROVIDER_HOSTS` cannot bypass forbidden ranges |
| OpenCode model dropdown is empty | OpenCode providers not configured or not logged in on the server | Have the administrator run `opencode auth login` on the server and configure providers |
| Qoder model fetch fails | Invalid PAT, or server qodercli below 1.0.0 | Regenerate the PAT; or upgrade with `qodercli update` on the server |
| localSession stops working after a container rebuild | The CLI HOME volume was deleted, or login was performed as root instead of appuser | Check that `a2wave-cli-home` exists and log in again with `docker compose exec -u appuser a2wave ...` |
| Trae model fetch returns nothing | Token invalid/expired, or no models configured in the enterprise console | Regenerate the CLI login token; ask your enterprise admin to configure models in the TRAE console |
| Kimi Code model dropdown is empty | Not signed in on the server, or no provider configured | Have the administrator run `kimi login` on the server, then fetch models again |
| Pi localSession model dropdown is empty | Pi has no usable credentials/models in the deployment config | Run `pi` as the service user, use `/login`, then fetch models again |
| Pi apiKey run rejects the model | The saved model is not an `openai/*` ID returned by Pi discovery | Fetch models again and select one of Pi's reported `openai/*` entries |
| Publish or resume reports `PROVIDER_BINDING_INVALID` | Pi apiKey mode has no Agent Key, or a Codex Agent Base URL has no Key in the same binding | Enter the Key for that binding, or remove the Agent Base URL and use the deployment Codex endpoint |
| The Config tab reports a Provider/MCP conflict, or a Pi Agent reports `PROVIDER_MCP_UNSUPPORTED` | Pi has no built-in MCP client, but the Agent mounts MCP Servers, configures A2A routes, or includes Pi in an MCP-using fallback chain | Follow the warning to remove the MCP-backed capabilities or Pi fallback, or choose a Provider with native MCP support, then publish or resume again; integrating a trusted Pi MCP extension requires explicit product review |
| Can't delete a Provider | Agents still depend on it | First change those Agents in the dependents list |

> [!CAUTION]
> Credentials are sensitive information; keep them per enterprise security standards, and never write them into system prompts or public channels.

## Related

- [Agent Management](/wiki/agents) · [Core Concepts & Architecture](/wiki/concepts) · [Skills](/wiki/skills)
