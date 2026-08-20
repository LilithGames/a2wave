# Repository Conventions

- **Language**: English is the primary language of this repo — code comments,
  commit messages, docs, and log/error messages are written in English.
- **IDs**: `agt_`, `prv_`, `mcp_`, `skl_`, `skg_`, `scm_`, `run_`, `rst_`, `msg_`,
  `usr_`, `aud_`, `art_`, `kbd_`, `att_`, `evs_`, `evc_`, `evt_`, `evr_`, `dev_`, `clt_` prefixes.
- **Naming**: camelCase (TS), snake_case (DB).
- **Imports**: `@/` → `apps/web/src/`, `@a2wave/shared` for shared.
- **Commits**: conventional (`feat:`, `fix:`, `refactor:`).
- **Product docs sync**: key business rule changes must be synced to
  [docs/PRODUCT.md](../PRODUCT.md).
- **User manual sync**: when adding or changing **user-facing** functionality
  (pages/routes, capability usage, trigger methods, workflows, terminology/limits),
  the in-app user manual (`/wiki`, content in
  `apps/web/src/content/manual/zh/`) must be updated in sync. **The
  `user-manual-sync` skill must be invoked** and followed per its conventions; when
  there is no user-visible change, note "manual update not needed" in the
  PR/commit.
- **Multi-language copy**: new or changed user-visible copy must maintain both
  `apps/web/src/locales/zh.json` and `en.json` (keys aligned), and update E2E as
  appropriate; details: [i18n.md](./i18n.md).
- **Page changes sync E2E**: when changing routes, navigation, page structure, or
  i18n copy, update the corresponding tests under `e2e/`. Navigation names match
  `nav` in `apps/web/src/locales/zh.json`; constants live in
  `e2e/utils/test-constants.ts`.
- **Audit logging**: **every new write operation (create/update/delete) must write
  an audit entry** via `logAudit()` (or `logBackgroundAudit()` for work with no
  request context). `details` is rendered verbatim to every admin, so it must
  **never** carry credentials, tokens, keys, or raw config — mask or hash instead.
  Each new action/resource needs zh + en copy, enforced by arch gate R7. Details:
  [audit-logging.md](./audit-logging.md).
- **Clean Code**: follow and use the `/clean-code` skill — meaningful naming, small
  functions, single responsibility, no side effects, avoid comment smells, Law of
  Demeter.
- **Changelog sync**: when creating a git tag (release), add a matching version
  entry to `CHANGELOG.md` summarizing the changes.
- **Release process**: update the CHANGELOG before creating a tag. Follow the
  `release-workflow` skill for the full release flow.

## UI Conventions

The web UI must follow the **design system tokens** (Tailwind semantic classes +
`tokens.ts` / `globals.css` consistent with the antd theme); Modal/Dialog must stay
consistent with existing wrappers such as
[apps/web/src/components/ui/dialog.tsx](../../apps/web/src/components/ui/dialog.tsx).
Detailed rules: [design-tokens.md](./design-tokens.md); **i18n**:
[i18n.md](./i18n.md). Component references:
`apps/web/src/pages/agent-detail/publish-tab.tsx`,
`apps/web/src/pages/agent-detail/index.tsx`.
