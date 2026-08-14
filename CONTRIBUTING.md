# Contributing to a2wave

Thanks for your interest in contributing! a2wave is a natural-language-driven agent
orchestration platform, and we welcome bug reports, feature proposals, docs, and
code. This guide covers everything you need to get a change merged.

By participating in this project you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to Contribute

- **Report a bug** — open a [bug report](./.github/ISSUE_TEMPLATE/bug_report.yml).
- **Propose a feature** — open a
  [feature request](./.github/ISSUE_TEMPLATE/feature_request.yml). Note that a2wave
  has explicit product boundaries (the "Iron Rules" in `AGENTS.md`); features that
  cross them need maintainer discussion first.
- **Ask a question** — use GitHub Discussions or the
  [question template](./.github/ISSUE_TEMPLATE/question.yml).
- **Report a vulnerability** — follow [SECURITY.md](./SECURITY.md); do **not** open
  a public issue.

## Product Boundaries (the Iron Rules)

Before proposing a feature, check it against these six rules. They define what
a2wave deliberately is *not*, and a proposal that crosses one needs maintainer
discussion **before** you write code — we would rather say so on the issue than
decline a finished pull request.

| # | Rule | What it means |
|---|------|------|
| 1 | **Orchestrate, don't execute** | a2wave is the orchestration layer; execution comes from the underlying agent CLIs (Claude Code / Cursor / Codex / …). We do not build our own LLM inference, code execution, or sandbox runtime. |
| 2 | **Extend through composition** | New capabilities arrive as Skills + MCP Servers, not as business logic hardcoded into the platform core. If a Skill or an MCP server can do it, it should not become a built-in feature. |
| 3 | **Natural-language-driven, not flow-driven** | Agents are configured and orchestrated in natural language — prompts, intents, A2A messages. No drag-and-drop DAG editor, no variable mapping, no conditional-branch primitives. |
| 4 | **Agent autonomy** | The platform creates, configures, triggers, and monitors Agents; it does not interfere with an Agent's runtime reasoning or tool-call decisions. No step approval or manual checkpoints that break autonomy. |
| 5 | **Enterprise-grade constraints, scoped by the trust model** | Security, auditability, and operability are hard requirements — never skip authentication, never allow anonymous invocation, never drop an audit entry, never put credentials in audit `details`. But the goal is accountability among trusted colleagues, *not* containment of a hostile insider; see [SECURITY.md](./SECURITY.md). |
| 6 | **The user's local Agent lowers the barrier, not another platform screen** | If a user can ask Claude Code, Codex, or Cursor Agent on their laptop to generate the prompt, YAML, or configuration and drive the CLI/API, do not add a wizard or form. Build machine-readable surfaces and invest UI effort in platform-only information and capabilities such as runtime, observability, channels, permissions, and audit. |

Full text and rationale: [AGENTS.md](./AGENTS.md#product-identity--iron-rules).

## Development Setup

Prerequisites: **Node.js >= 22** and **pnpm >= 9**.

```bash
pnpm install                # install workspace dependencies
cp .env.example .env        # leave AUTH_SECRET empty — `pnpm dev` generates one into .env
pnpm dev                    # API on :3502 + Web on :3501 (override with PORT / WEB_PORT)
pnpm stop                   # free the ports if a previous run left orphans
```

The repository is a pnpm monorepo:

```
apps/api/         # Hono + SQLite (Drizzle ORM) + local agent execution
apps/web/         # React 19 + Vite + Tailwind v4 + Ant Design
apps/cli/         # CLI tool (a2wave command)
packages/shared/  # Zod schemas & shared types
```

See [AGENTS.md](./AGENTS.md) for the full architecture, API surface, and database
workflow.

## Quality Gates (required before every commit)

These three gates are non-negotiable — CI blocks on the first two, and the local
git hooks (husky) run them automatically. **Do not bypass with `--no-verify`.**

| Gate      | Command                | Requirement                    |
| --------- | ---------------------- | ------------------------------ |
| Lint      | `pnpm lint`            | 0 errors (Biome)               |
| Typecheck | `pnpm typecheck`       | `tsc --noEmit` fully green     |
| Test      | `pnpm test`            | All pass; new code ships tests |

Use the root scripts above rather than `pnpm -r typecheck` directly: every app
resolves `@a2wave/shared` through its build output, which is gitignored and so
absent on a fresh clone. The root scripts build it first; the bare recursive form
fails with a wall of unresolved-import errors.

Run E2E for changes touching critical user paths:

```bash
npx playwright install chromium   # once per machine — browsers are not vendored
pnpm test:e2e                     # Playwright
```

## Test-Driven Development

All new features and bug fixes follow **red → green → refactor**:

1. **Red** — write a failing test stating the expected behavior.
2. **Green** — write the minimum code to pass.
3. **Refactor** — improve structure under test protection.

Bug fixes must include a regression test that reproduces the bug. New routes and
pages must ship with tests. Test files live in a `__tests__/` directory next to the
source, named `<source-file>.test.ts`.

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/). The allowed
types are: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`,
`build`, `ci`, `revert`. The commit hook validates this.

```
feat(provider): add Qoder CLI execution engine
fix(auth): reject tokens with mismatched issuer
```

## Pull Request Process

1. Fork the repo and create a branch from `main`.
2. Make your change following the conventions above; keep the diff focused.
3. Ensure `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass locally.
4. Update user-facing docs, i18n copy (`zh.json` **and** `en.json`), and the
   in-app manual when your change affects users.
5. Open a PR against `main` and fill in the PR template, including the testing
   checklist. CI must be green and at least one maintainer review is required.

## AI Contribution Policy

a2wave is itself built with heavy use of AI coding agents, gated by a full test
pyramid and human review — so **AI-assisted contributions are welcome**. In return
we ask that you keep the bar high:

- **You are responsible for what you submit.** Understand the code, and run and test
  it yourself before opening a PR — do not submit unreviewed generated output.
- **Disclose significant AI involvement** in the PR description when a change was
  substantially machine-generated.
- **No "AI slop."** PRs that are clearly unverified generated text, add no value, or
  don't build/pass tests will be closed.

Human judgement and accountability are required regardless of the tools used.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE) that covers this project.
