# FAQ

## Does a2wave run models itself?

No. a2wave is the **orchestration layer**; execution comes from the underlying agent CLIs (Cursor / Claude Code / Codex). The platform does not build its own LLM inference, code execution, or sandbox. You must configure a [Provider](/wiki/providers) first before an Agent can run. See [Core Concepts & Architecture](/wiki/concepts).

## For a new capability, should I use a Skill, an MCP, or a Knowledge Base / Memory?

- Calling an external system/tool → [MCP Server](/wiki/mcp-servers)
- Packaging a reusable process or knowledge → [Skill](/wiki/skills)
- Searchable factual material → [Knowledge Base](/wiki/knowledge-base)
- Cross-session preferences and history → [Long-Term Memory](/wiki/memory)

The principle is "extend through composition": anything solvable with a Skill / MCP should not be made a built-in platform feature.

## Why isn't my Feishu Agent receiving messages?

The most common cause is a **occupied Feishu long connection**: within a single API process, a given Feishu App ID may hold only one active long connection, and the first to start takes priority. Multiple Agents connecting to Feishu should each use a **separate Feishu app**. The connection status is shown directly on the channel cards in the Publish tab (Feishu, Slack and Discord each display their protocol and live status); the Agents list and the detail header also carry a summary indicator so a dropped connection is visible while scanning. It is also reported in the Agent's "Full Diagnosis". See [Trigger Methods](/wiki/triggers).

## Why doesn't an API call return the result directly by default?

`/invoke`'s `async` defaults to **true**, immediately returning a `runId`, so you poll `runs/:runId`. To get the result synchronously, pass `"async": false` (see [Trigger Methods · API](/wiki/triggers)).

## What do I do when an invocation returns 429?

First check `error.code`:

- `RATE_LIMITED`: the caller exceeded the API request rate; wait per `Retry-After` and retry.
- `AGENT_QUEUE_FULL`: the Agent's execution queue is full; wait for existing Runs to finish; the Agent owner can also consider adjusting `maxConcurrency`.

Both are HTTP 429, but the next step differs — don't handle by status code alone.

## No response / empty output after publishing an Agent?

1. Run **Full Diagnosis** on the detail page to check the Provider and execution engine.
2. Go to [Runs](/wiki/runs) to see the corresponding Run's log and error.
3. Confirm the trigger configuration is correct (API Key, Feishu app, cron expression, etc.).

## I can't see a certain Agent?

Agents are isolated by member permission; you only see Agents where you are owner/editor/viewer. Please ask its owner to add you as a member. See [Member Management](/wiki/members).

## The Agent's memory is gone after a restart?

Memory is stored in the local `./data`. A container deployment must mount `./data` as a persistent volume, otherwise it's lost on restart. See [Long-Term Memory](/wiki/memory).

## Is anonymous invocation supported?

No. a2wave's enterprise-grade constraints come first: no anonymous invocation, no skipping authentication.

## Are credentials still there after cloning an Agent?

No. Cloning clears all `sensitive` environment variables and Provider credentials (only `authMode` is kept to prompt you to refill).

## Where do I open the user manual?

Click your avatar at the bottom left and pick "User Manual" from the popup menu — that opens this manual (`/wiki`). The entry sits just above "About"; it is not in the left navigation bar.

## Does signing out ask for confirmation?

Yes. Clicking "Sign Out" opens a confirmation dialog so a misclick cannot log you out. Confirming revokes the current session token and you will need to sign in again; "Cancel" keeps you signed in.

## How do I view the platform version and change history?

Click "About" in the user menu at the bottom left; the dialog shows the product intro, developer info, and current version number, and provides two entry points:

- **Changelog**: jumps to the [Changelog](/changelog) page to view the change history of each version.
- **GitHub**: opens the a2wave open-source repository in a new window.

## How do I get the a2wave CLI?

Click "Get CLI" in the user menu at the bottom left; the install command is copied straight to your clipboard, ready to paste into a terminal:

```bash
npm i -g a2wave
```


## How is the admin password set?

By whoever **operates the a2wave deployment**, at install time, in one of two ways:

- Installing with `a2wave setup` from an interactive terminal prompts for the admin password twice (not echoed), so you can sign in as soon as it finishes. A non-interactive install with `--yes` skips this step.
- If it was skipped or never prompted, the first visit to the platform URL walks you through setting the admin password — no separate setup code required.

The password is typed only into that terminal or browser — it never lands in a config file, a container environment variable, or a command-line argument. Note that until the admin password is set, the setup endpoint is unauthenticated and whoever completes setup first becomes the administrator: initialize right after deploying, or deploy with `ADMIN_PASSWORD` to skip that window.

## What if the admin forgets the password?

This is likewise done by the operator, on the server itself — a regular user cannot and should not do this; contact your admin to recover it:

- Instance installed with `a2wave setup`: run `a2wave setup --reset-password` from a terminal that can reach that server, and follow the prompt for a new password (typed twice, not echoed). Effective immediately, no restart.
- Other Docker deployments: `docker exec -it --user appuser <container> node /app/apps/api/dist/scripts/set-admin-password.js`.

The new password is typed only inside the container — it never passes through shell history or logs. A reset also **revokes every signed-in session and token** for that admin, so you will need to log in again. **Do not** try to recover it via the `ADMIN_PASSWORD` environment variable — it only takes effect when the admin account has never had a password set, and editing it does nothing once one already exists.

## How do I upgrade the platform to a new version?

This is done by an operator on the server; regular users do not need to do anything.

For an instance installed with `a2wave setup`, run this from a terminal that can reach that server:

```bash
a2wave setup --upgrade --image <new image>
```

`--image` is optional: omitting it upgrades to the official image matching the CLI's own version (`ghcr.io/lilithgames/a2wave:<cli-version>`). The platform and the CLI share one version line, so `a2wave update` followed by `a2wave setup --upgrade` moves the instance to the matching release. Pass the flag only for a self-built or private image.

It rewrites only the `A2WAVE_IMAGE` line in `.env` (the compose file reads the image through that variable), then re-pulls and recreates the a2wave service, and only reports success once the instance passes both its health and readiness checks. The command **never deletes the data volume**, and everything else in `.env` (`AUTH_SECRET`, `COMPOSE_PROJECT_NAME`, …) survives byte-for-byte, so existing login sessions are unaffected; `docker-compose.yml` is never regenerated, so local edits such as extra mounts or `extra_hosts` are preserved.

If the new image fails to start or never becomes ready, it automatically restores the previous image, brings it back up, and confirms it is healthy before finishing.

**The upgrade backs the data volume up automatically.** It stops the container first (so a half-written SQLite file is never copied), packs the whole volume into `a2wave-data-<timestamp>.tar.gz` in the install directory (mode 0600, newest 3 kept — it is a full database copy, credentials and tokens included), and, if that fails, restarts the container before aborting so the instance is never left stopped. Pass `--no-backup` to skip it if you run your own snapshots.

That backup matters because automatic rollback is not a guarantee: a new version may already have applied an irreversible database migration that the previous version cannot read, so rolling the *image* back does not roll the *data* back. The command says so explicitly rather than reporting a false success. When restoring from a snapshot, **follow these steps in order** — do not collapse them into one command:

**1. Stop the service first.** The container may still be running and holding the SQLite file; deleting data underneath a live writer corrupts the database:

```bash
cd <install dir> && docker compose stop a2wave
```

**2. Verify the archive is readable** and actually contains the database — discovering a corrupt tarball *after* wiping the data leaves you with nothing:

```bash
tar tzf a2wave-data-<timestamp>.tar.gz | grep a2wave.db
```

**3. Restore into a NEW volume** rather than overwriting in place, so the original stays intact if the restore goes wrong:

```bash
docker volume create <project>_a2wave-restore
docker run --rm -v <project>_a2wave-restore:/data -v "$PWD":/backup alpine \
  tar xzf /backup/a2wave-data-<timestamp>.tar.gz -C /data
```

**4. Point compose at the new volume.** Do **not** rename the `a2wave-data:/app/data` mapping inside the service — compose prefixes logical volume names with the project name again, so a renamed mapping mounts a freshly created empty volume instead. Keep the service untouched and declare the top-level volume as external:

```yaml
volumes:
  a2wave-data:
    external: true
    name: <project>_a2wave-restore
  a2wave-cli-home:
```

**5. Start it and verify** (pass `-p` / `-f` explicitly so compose cannot resolve a different project or file):

```bash
docker compose -p <project> -f <install dir>/docker-compose.yml up -d --no-deps a2wave
curl -fsS localhost:<port>/api/health/ready
```

`curl -fsS` exits non-zero on a non-2xx response, which a bare `curl` does not. Beyond the health check, **log in and confirm your actual data is back** (agent list, run history) before deleting the old volume.

## Can I use PostgreSQL as the database?

Yes, but **SQLite remains the default and recommended backend** — one container, no external dependency, and the best choice for a single-instance deployment. PostgreSQL is an **experimental** backend aimed at multi-instance deployments; note there is **no SQLite → PostgreSQL data migration tool**, so switching means starting from an empty database.

Choose it at install time (performed by the operator):

```bash
# Connect to an external PostgreSQL (9.6+)
a2wave setup --database-url postgres://user:password@db-host:5432/a2wave

# Or let the installer bundle a postgres:16-alpine service in compose;
# the password is generated into the install directory's .env (mode 0600)
a2wave setup --with-postgres
```

The two flags are mutually exclusive and cannot be combined with `--upgrade`. To switch an existing install, edit `DATABASE_URL` in the install directory's `.env` and run `docker compose up -d` (again starting from an empty database).

> [!IMPORTANT]
> These options were added after CLI v0.7.2 and are not present in the published `a2wave@0.7.2` package. Confirm that `a2wave setup --help` lists them before installation. If either option is unknown, install a newer CLI before retrying; do not continue with the generated deployment, because SQLite remains the default.

> [!WARNING]
> Do not point the database URL at `localhost` — inside the container, localhost is the container itself. For a database on the host machine, use `host.docker.internal` (Docker Desktop) or the host IP. Also, on a PostgreSQL install the automatic pre-upgrade backup covers only the data volume, **not** the database itself — take a `pg_dump` before upgrading.

## Still have questions?

Check the in-app API docs at `/api/docs` (Swagger UI), or contact the platform admin.
