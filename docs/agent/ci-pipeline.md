# CI Pipeline, Local Hooks & Architecture Rules

## CI jobs (GitHub Actions, [`.github/workflows/`](../../.github/workflows/))

CI is an **orchestrated pipeline behind a single aggregate gate**: branch
protection requires only `all-checks-pass`, which treats `skipped` as success and
any `failure` as red — so adding or gating a job never needs a branch-protection
edit, and a new job can never land unprotected.

A `detect` job classifies the PR diff once (`scripts/ci/detect-changes.mjs` — pure,
unit-tested, **fail-open**: unrecognised files and pipeline-touching paths turn
every lane on, and push-to-main always runs everything, so lane skipping never
weakens post-merge validation; skipping happens *inside* the workflow, never via
`on.paths`, which would leave a required check pending forever).

**Always-on quality floor**: `lint` (biome + repo-wide arch/forbidden-token/
file-line sweeps + pinned `actionlint`), `typecheck`, `secret-scan` (gitleaks, full
history), `audit` (`pnpm audit`, critical level).

**Lane-gated**: `test-web`, `test-cli` (cli + the `scripts/` `node --test` groups),
`test-api` (**4 parallel shards** through `scripts/gates/check-api-tests.mjs`),
`license-inventory` (package.json/lockfile diffs), `pgschema` (regenerates
`schema.pg.ts` and fails on any diff).

`review-labels` blocks PRs touching CI-sensitive paths (workflows, gate scripts,
`provider-cli-lock.json`, test configuration, DB migrations) until a maintainer adds
the **`ci-reviewed` label** — the counterweight to merge-on-green.

### Actions are pinned to commit SHAs

Every `uses:` that points outside this repository — `actions/*` included — is
pinned to a **full 40-character commit SHA** with a trailing `# vX.Y.Z` comment:

```yaml
- uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
```

A tag is mutable and its owner can repoint it at any time, so `@v6` means
"whatever that account publishes next" in jobs that hold `NPM_TOKEN` and the GHCR
push token — the exact position the 2025 `tj-actions/changed-files` compromise
turned into leaked secrets across thousands of repositories. A SHA is the commit
we reviewed and nothing else.

Bumping one by hand means resolving the SHA yourself:

```bash
gh api repos/<owner>/<repo>/tags --jq '.[] | "\(.name) \(.commit.sha)"'
```

Normally you should not have to: Dependabot's `github-actions` ecosystem
([`.github/dependabot.yml`](../../.github/dependabot.yml)) rewrites both the SHA
and the version comment weekly, and covers the composite action in
`.github/actions/setup` through its own `directories` entry.

PR runs of the same ref cancel superseded runs; pushes to main never cancel.
Merge-latency baseline lives in `scripts/ci/merge-latency.mjs` (run quarterly).

**Tag-triggered**: `release` (`v*`), `docker` (`v*` + manual; `:latest` moves
**only** on a tag run), `publish` (`v[0-9]+.[0-9]+.[0-9]+`, prerelease shape
included — the CLI shares the platform version line, so there is no separate
`cli-v*` tag; needs `NPM_TOKEN`). `release-check` warns when HEAD is ≥10 commits
past the latest tag.

**Schedule-triggered, in a separate workflow**: `post-merge` runs the work that
cannot fit the merge gate — `pnpm test:all` plus the restart-recovery scenarios
daily at 01:00 UTC, and the onboarding fresh-clone E2E on Mondays at 02:00 UTC (the
two cron expressions must stay distinct: the onboarding job selects itself with
`github.event.schedule`). It is deliberately outside `all-checks-pass`, so it never
blocks a merge, and `cancel-in-progress: false` keeps each run as the validation
record of the tree it ran against. Failures notify nobody by design — the Actions
tab is the surface, and the maintainer owns the fix. `workflow_dispatch` runs either
job on demand.

### `check-api-tests.mjs` waivers

Two waiver lists, `BASELINE` (per assertion) and `SUITE_BASELINE` (whole file);
**both are now empty**, so every api test is under full regression protection. A
waived file has no protection at all, so both lists **shrink, never grow** — an
addition needs a recorded reason.

The job must install **without** `--ignore-scripts` — `better-sqlite3` may build its
native addon from source, and skipping install scripts fails every test on a missing
addon instead of a real regression.

## Local hooks (husky v9, wired by `prepare` on `pnpm install`)

- **pre-commit** — `lint-staged` (biome autoformat) · `check-forbidden-tokens` ·
  `check-arch-rules` · `check-docker-context` · `check-file-lines` (≤3000
  lines/file; existing violations frozen in an allowlist, shrink-only)
- **commit-msg** — `check-commit-msg` enforces Conventional Commits
  (feat/fix/refactor/docs/test/chore/style/perf/build/ci/revert)
- **pre-push** — changed-file biome vs `origin/main` → shared build →
  `pnpm typecheck`

Gate scripts in `scripts/gates/` carry their own allowlists;
`node scripts/gates/check-*.mjs --all` sweeps the whole repo.

## Architecture rules R1–R9

1. apps must not import each other
2. shared must not depend back on apps
3. `@/` is web-only
4. no `@ts-ignore` / `@ts-nocheck`
5. locales zh/en key sets aligned
6. `--no-verify` bypass is forbidden (no hook can block it; CI is the backstop)
7. every audit action/resource has zh+en copy
8. antd feedback APIs (`message` / `notification` / `Modal.confirm`) must come from
   `@/lib/antd-static`, never `from 'antd'` — the static instance renders outside
   `<StyleProvider layer>`, so its unlayered `a` reset repaints every sidebar link
   link-blue
9. `apps/web` must not pull in `@radix-ui/*` / `cmdk` / shadcn

**Only R1–R5, R7 and R8 are mechanically enforced** — `check-arch-rules.mjs` prints
`✓ all sources pass R1–R8` and skips R6 and R9, which sit in its second-wave backlog
because both are heuristic and would need long-term allowlist tuning. Treat **R6 and
R9 as review-enforced conventions**: adding a shadcn component or a `@radix-ui/*`
dependency passes every local hook and CI job today, so a reviewer has to catch it.
