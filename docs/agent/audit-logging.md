# Audit Logging — What to Record and What Never to Record

Audit logs answer one question after the fact: **who changed the platform's state, and what did they change?** They are an Iron Rule 5 hard requirement (auditability), and the page that renders them is `/audit-logs`, backed by `GET /api/audit-logs`.

Helpers live in [`apps/api/src/lib/audit.ts`](../../apps/api/src/lib/audit.ts); the shared action vocabulary lives in [`apps/api/src/lib/audit-actions.ts`](../../apps/api/src/lib/audit-actions.ts).

## Rule 1 — Every new write operation must write an audit entry

**Any route that creates, updates, or deletes state must call `logAudit()`.** This is not optional and not deferred to a follow-up MR. A write with no audit trail is an accountability hole: it makes "who deleted this Agent" permanently unanswerable.

```ts
import { logAudit } from '../lib/audit.js'

logAudit(c, {
  action: 'skill.delete',
  resource: 'skill',
  resourceId: skill.id,
  details: { name: skill.name },
})
```

- `action` — `<resource>.<verb>`, lowercase, dot-separated (`agent.create`, `user.role.updated`). Reuse an existing verb (`create` / `update` / `delete` / `publish` / `stop` / `resume`) so the page's colour mapping keeps working.
- `resource` + `resourceId` — the entity touched. Most entries carry a `resourceId` and no `details`, and the page relies on it to identify the row.
- The user and IP come from the Hono context automatically. Don't pass `userId` unless the acting identity genuinely differs from the session.

### Account deletion preserves the actor

Deleting an account snapshots its ID and username into `details.deletedActor`
in the same update that clears the audit row's foreign key. Existing details are
preserved: `details.username` may describe the operation's target, and ordinary
mutation entries often have no details at all. `GET /api/audit-logs` falls back
to the snapshot for the displayed username once the actor's account is gone.
The deletion transaction rolls this update back if deletion is refused.

### Background work uses `logBackgroundAudit()`

Work with no request context — the data-retention sweep, evaluation execution — has no session to attribute to, but still needs a trail. Identity comes from the row that scheduled the work:

```ts
logBackgroundAudit({
  action: 'evaluation_task.execute',
  resource: 'evaluation_task',
  resourceId: taskId,
  userId: task?.userId ?? undefined,   // whoever scheduled it, not a live session
  details: { agentId, status, casesRun, turnsReplayed, durationMs },
})
```

Evaluation is the canonical case: it deliberately writes **no** `runs` row (see the Evaluation section in the root `CLAUDE.md`), so `evaluation_task.execute` is what satisfies auditability — and it must be written **on every terminal path, including failure**.

### Also audit these non-write operations

Read-only calls get an entry when they are security-sensitive or expensive:

| Action | Why it's audited despite not writing |
|---|---|
| `auth.login`, `auth.oauth.login` | Authentication is itself an audit subject |
| `auth.oauth.exchange_failed` | **Failures** matter — this is how attacks and misconfiguration get diagnosed |
| `agent.diagnose` | Exposes Provider and connection details |
| `scm_source.probe`, `mcp_server.probe_stdio` | Dials out with credentials; rate limited |

### What is *not* audited

An Agent's per-turn execution detail. That belongs to the `runs` table and run logs. Iron Rule 4 — the platform does not intervene in Agent execution — applies to the audit trail too.

### Repeated non-events are not audit entries

Only log an event where **something actually changed**. If a code path recomputes the same derived result on every request without persisting anything, logging it produces a stream of identical rows that buries the real events and misrepresents a routine match as a state change.

The concrete precedent: cross-protocol SSO email merging re-runs on every login by design (it deliberately writes nothing, because `users` stores a single `(issuer, sub)` pair while a user's `sub` differs per protocol). It used to log `AUTH_OAUTH_USER_LINKED` each time, which made every login look like a fresh account link. That evidence now rides in the login entry's `details`; `AUTH_OAUTH_USER_LINKED` is reserved for the bind flow, which really does write the identity, exactly once.

## Rule 2 — Never leak secrets into `details`

`details` is stored as plaintext JSON and rendered verbatim in the audit page, which **every admin can read**. Treat it as public within the deployment.

**Never put in `details`:**

- Passwords, PATs, `p4passwd`, API keys, Agent API keys
- Provider credentials or any `sensitive` env var value
- Raw JWTs, bearer tokens, cookies, session tokens
- Private keys, signing keys, JWKS private material
- Full request bodies or config objects that might carry any of the above

**Instead:**

| Don't | Do |
|---|---|
| `{ pat: config.pat }` | omit it, or `{ hasPat: true }` |
| `{ config }` (whole SCM config) | `maskScmConfig(config)` — see [`scm-secret-mask.ts`](../../apps/api/src/lib/scm-secret-mask.ts) |
| `{ email }` on a **failed** auth path | `{ emailHash: hashEmail(email) }` |
| `{ token }` | `{ tokenPrefix: token.slice(0, 8) }`, or nothing |

Note the asymmetry on email: on a **successful** login the email identifies a legitimate user and is recorded plainly. On a **failure** path it may be an address the caller does not control (enumeration probe), so `hashEmail()` records a stable identifier without storing plaintext. Follow the existing calls in [`sso-login.ts`](../../apps/api/src/lib/sso-login.ts).

Keep `details` small and purposeful: the fields a reviewer needs to understand *what changed*, not a dump of the request.

> The `check-forbidden-tokens` pre-commit gate catches hardcoded credentials in source. It does **not** and cannot catch a secret you route into `details` at runtime — that one is on the author and the reviewer.

## Rule 3 — Every action needs zh + en copy (enforced)

The audit page renders a translated label. A missing translation degrades to the raw key (`auth.oauth.login`), which is unreadable for most users.

When adding an action or resource, add its label to **both** locale files:

- `apps/web/src/locales/zh.json` → `auditLogs.actions` / `auditLogs.resources`
- `apps/web/src/locales/en.json` → same

**Arch gate R7 enforces this** (`scripts/gates/check-arch-rules.mjs`, runs in pre-commit): it scrapes every action and resource written by `apps/api` and fails the commit if either locale lacks a label. It lives in `scripts/gates` rather than a unit test because it spans both apps, and importing web locales from `apps/api` would violate R1.

The filter dropdowns on the audit page are built from this same catalogue, so an action with no label is also absent from the filter.

## Checklist for a new write route

- [ ] `logAudit()` called on the success path (and on terminal failures worth recording)
- [ ] `action` follows `<resource>.<verb>` and reuses an existing verb where one fits
- [ ] `resource` + `resourceId` set
- [ ] `details` contains no credential, token, key, or raw config — re-read Rule 2
- [ ] Labels added to `auditLogs.actions` / `auditLogs.resources` in **both** zh and en
- [ ] `node scripts/gates/check-arch-rules.mjs --all` passes
