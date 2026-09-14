# Agent CLI: installed at runtime, not baked in

**The image preinstalls no Agent CLI.** The roster adds well over 1GB (plus
CodeGraph) while a deployment typically binds one or two. Admin-only.

## `provider-cli-lock.json`

Two arrays:

- `providers` — CLI `kind` contract-tested against `PROVIDER_KINDS`.
- `tools` — CLIs a2wave installs that are **not** Providers. CodeGraph is the only
  one today; it indexes SCM sources and has no Provider record, so putting it in
  `providers` would break that four-way contract.

Installs reuse the lock and `scripts/provider-clis/install.mjs` with the same
pinned versions and SHA-256/SRI verification the build once performed — there is
**no floating `curl | bash` path**. Upgrading a version means editing the lock
(reviewed via MR), not typing one into the UI.

A pin may deliberately **trail the latest release**. kimi is held at 0.31.x: from
0.32.0 its `-p` mode skips the project-level `.kimi-code/mcp.json` in a folder it
has not marked trusted, with no headless opt-out, so a bump would silently strip
every Agent's MCP tools. `cli-invocation-surface.test.ts` fails if the pin
reaches 0.32.0, and the adapter strips `KIMI_CODE_EXPERIMENTAL_FLAG`, which opts
0.31.x into the same engine.

Tracked in `cli_installations`, keyed by **lock identity, not Provider id** —
a managed CLI need not be a Provider.

## Install location and probing

- **Where they land**: `A2WAVE_CLI_INSTALL_ROOT` (`/home/appuser/.a2wave`), inside
  the persisted `a2wave-cli-home` volume — an image upgrade does not force a
  reinstall, but `docker compose down -v` deletes them. Both `bin/` and `npm/bin/`
  are on `PATH` and engines spawn bare names (`CLAUDE_CODE_PATH` defaults to
  `claude`), so no engine code is CLI-location-aware.
- **`installed` is always probed from `PATH`**, never read from the DB — a CLI can
  be removed outside a2wave, so `cli_installations` records the *job* (status /
  last error / output), not the truth. A missing row degrades to `idle`, not
  "not installed".
- A failed install cleans up its partial tree — no dangling symlink looks
  installed. Status is persisted, so a crash mid-install settles to `error` at
  startup instead of wedging in `installing` forever.

## Pin vs floor: `lockDrift`

- **The lock pins an exact version, not a floor.** `versionOutputMatches()`
  compares whole tokens for equality; `PRESET_PROVIDERS.minVersion` is the
  *minimum* the engine gates on via `isVersionAtLeast()`.
- Conflating them is why `lockDrift` exists: reporting only match/mismatch made a
  build **newer** than the pin look outdated, and the offered "update" silently
  **downgraded** it while the engine was fine.
- `lockDrift` is `match` / `below` / `above` / `unknown` (null when not installed)
  and carries direction, so the UI offers "update" only for `below`.

## `minVersion` floors are guarded by a snapshot, not derived

`apps/api/src/engine/__tests__/cli-invocation-surface.test.ts` snapshots the CLI
tokens each engine adapter can pass and fails on drift, so adding a flag that only
exists in a newer CLI forces the author to confirm (or raise) the floor instead of
silently invalidating it. The same file asserts every lock pin is `>=` its
Provider's floor.

## Probing a floor against reality

The snapshot catches drift but cannot decide whether a floor is *right*.
`node scripts/verify-provider-min-versions.mjs` (alias
`pnpm provider-min-versions:verify`) reads that snapshot, installs each Provider's
declared floor from npm into a temp dir, and checks the floor actually **accepts**
every flag its adapter passes — the dangerous direction, since a floor set too low
passes the version gate and then breaks at spawn time.

Manually-run: it needs network and takes minutes, so it is **not** in `pnpm test`
or the hooks (only its pure helpers are unit-tested; `--snapshot <path>` overrides
the default snapshot location).

Notes on reading its output:

- Verdicts come from **acceptance probing**, not help-text scraping: a supported
  flag gets past argument parsing and fails later (a credentials error is a
  **positive** result). A `--version` **control gate** runs first, because some
  published builds fail everything identically and would otherwise read as
  "missing every flag".
- **Acceptance probing only works on a CLI that rejects unknown flags detectably**,
  so a **classifier self-test** runs right after the control gate: a sentinel flag
  (`--a2wave-nonexistent-sentinel`) nothing can legitimately support is probed
  through the same two-phase path. If the CLI does not *reject* it, every verdict
  for that CLI is **withheld**. Not hypothetical — **qodercli 1.0.0 answers any
  unknown flag with its usage banner on exit 0** while `--version` returns a clean
  `1.0.0`, so it cleared the control gate, every flag classified as `accepted`, and
  the tool reported a confident all-clear for a floor it had never tested.
- Probes run under an **allowlisted environment** with `HOME`/`TMPDIR` pointed at
  the throwaway install dir. These are published third-party builds being executed,
  so no ambient credential reaches them — and the empty `HOME` is also what
  guarantees the CLI finds no session and takes the deterministic "no API key"
  branch the classifier depends on.
- Only **npm-distributed** CLIs are candidates (qoder / kimi / pi / codex);
  `curl | bash` installers publish no enumerable versions. Codex declares no floor,
  and **qoder fails the sentinel self-test at its 1.0.0 floor — it is not
  probeable by this method** (1.1.x builds do reject unknown flags, so raising the
  floor would make it probeable). Today's actually-verifiable set is therefore **kimi and pi**.
- It exits non-zero **only** for a flag the floor genuinely rejects. **Exit 0 does
  not mean "all floors verified"**: a withheld Provider yields no evidence, which
  is not a failure but is not a pass either, so the report names the verified and
  the withheld set on every run. Read that, not the exit status.
- A top-level rejection is downgraded to `inconclusive` **only when some candidate
  subcommand chain fails to reject the same flag** (every single bare word in the
  surface, then every ordered pair, capped at 12). The earlier blanket rule — "the
  surface contains any bare word, therefore excuse every rejection" — masked
  genuine defects on mixed surfaces like qoder and opencode, which carry top-level
  flags *and* a `status` subcommand. `kimi --json` is still correctly excused,
  because it really does parse as `kimi provider list --json`.
- It cannot decide whether the CLI's **output shape** matches what the adapter
  parses, and it never says a floor is *higher* than it needs to be.

## Diagnosis and UI

- `GET /api/agents/:id/diagnose` reports `provider_cli_not_installed` (severity
  `error`) when a bound Provider's CLI is absent; without it diagnosis reads
  all-green while every run fails at spawn with `ENOENT`. It reports
  `provider_cli_version_below_minimum` (severity `error`) when the CLI is installed
  but below that preset's `minVersion` floor. **Neither blocks the run** — no
  diagnose check does.
- **There is no standalone Agent CLI page** — install/update/uninstall live on the
  Providers list card and Provider detail page. CodeGraph therefore has **no UI
  entry** and is installed via the API.

## Provider model discovery

A **Provider must be able to enumerate the models its bound credentials can run** —
a hard onboarding condition, so `modelDiscovery` is `automatic` or `manual` with no
"unsupported" escape hatch. Providers persist **no model catalog** and expose **no
editable field**: the list is probed from the CLI per Agent credential and cannot
drift from what the account really has. (`copilot` was retired under this rule —
its CLI has no model-list command.)
