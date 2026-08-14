<!--
Thanks for contributing to a2wave! Please fill in the sections below.
See CONTRIBUTING.md for the full process and quality gates.
-->

## Summary

<!-- What does this PR do and why? Link any related issue: Closes #123 -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation only
- [ ] Refactor / chore

## Testing checklist

<!-- Report gate RESULTS, never pasted terminal output. pnpm prints the absolute
     path of each package before every script it runs, so pasting a run log
     leaks local directory structure (and buries the result in thousands of
     lines). Write "0 errors, 426 warnings (unchanged from main)", not the log.
     A CI check rejects PR bodies containing home-directory paths. -->

- [ ] `pnpm lint` passes (0 errors)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes; new/changed code is covered by tests
- [ ] E2E updated/run if this touches critical user paths, routes, or i18n
- [ ] User-facing docs, i18n copy (`zh.json` **and** `en.json`), and the in-app
      manual updated where relevant (or "not applicable")

## Cross-cutting change matrix

<!-- Delete this section when it is not applicable. For SCM storage changes,
read docs/agent/scm-storage-invariants.md and mark every affected path. -->

- [ ] Create / import / bootstrap paths checked
- [ ] PATCH / enable-disable / cancellation paths checked
- [ ] DELETE / cleanup / audit paths checked
- [ ] Startup recovery and upgrade compatibility checked
- [ ] Git and P4 behavior checked where applicable
- [ ] SQLite and PostgreSQL behavior checked where applicable
- [ ] Named volume, default bind, explicit bind, and macOS bind behavior checked
      where applicable
- [ ] Failure recovery and operator remediation are documented

## AI assistance disclosure

- [ ] This change was substantially AI-generated. If checked, I confirm I
      understand the code and have tested it myself (see CONTRIBUTING.md).

## Additional notes

<!-- Screenshots, migration notes, follow-ups, anything reviewers should know. -->
