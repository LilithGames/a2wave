# Agent API Keys

> Status: v1.0. Named, individually revocable keys for an Agent's **API** (REST
> gateway) and **A2A** inbound channels. Managed from the Agent's Publish tab; the
> plaintext is shown once and never again.

## Table of Contents

- [1. Why multiple keys](#1-why-multiple-keys)
- [2. The model](#2-the-model)
- [3. Endpoints](#3-endpoints)
- [4. Verification path](#4-verification-path)
- [5. Run provenance](#5-run-provenance)
- [6. Migration from the single-key columns](#6-migration-from-the-single-key-columns)
- [7. Security properties](#7-security-properties)

---

## 1. Why multiple keys

Each channel used to hold **one plaintext key** in a column on `agents`
(`endpoint_api_key`, `a2a_endpoint_api_key`). Two consequences drove this change:

- **Rotation was all-or-nothing.** `POST /agents/:id/regenerate-api-key` overwrote
  the column, so every integration holding the old key broke at once. There was no
  way to retire one caller's credential, and no grace window.
- **A database read yielded working credentials** for every published Agent —
  backups, a read replica, or an accidental dump all carried live keys. Masking on
  the API surface (`maskAgentSecrets`) hid it from the browser but not from the disk.

There was also no way to answer "what is this key for?" or "is anyone still using
it?", so keys accumulated and nobody dared revoke any.

---

## 2. The model

`agent_api_keys`, one row per key:

| Column | Purpose |
|---|---|
| `channel` | `api` or `a2a`. Part of the lookup — the two **never** interchange |
| `key_hash` | SHA-256 (hex), unique. The plaintext never touches the database |
| `key_prefix` | First 11 chars, shown in the list to tell two keys apart |
| `name` | **Required** description, max 24 chars. Shown in run history as the trigger |
| `expires_at` | Null means no expiry (deliberately allowed) |
| `last_used_at` / `last_used_ip` | Best-effort, throttled to once a minute |
| `revoked_at` | Soft delete; revocation takes effect on the next request |

Prefixes are unchanged from the legacy columns — `ak_` for `api`, `a2ak_` for `a2a` —
so existing keys stay recognisable and the two cannot alias.

`name` is capped at 24 characters (`MAX_KEY_NAME_LENGTH`) because it is rendered both in
the key list and as the run-history trigger column, where a longer value wraps the row or
truncates to something unrecognisable.

**At most 20 active keys per Agent per channel.** Without a cap, one leaked
credential could seed unlimited backdoor keys and drown the list an operator would
use to spot them.

---

## 3. Endpoints

All require **write** on the Agent (owner / editor / admin), matching the
`regenerate-api-key` endpoint they supersede. Key metadata — last-used time, the
display prefix, which integrations exist — is operational information, so viewers do
not see it.

| Endpoint | Purpose |
|---|---|
| `GET /api/agents/:id/api-keys?channel=api\|a2a` | List. Never returns a credential |
| `POST /api/agents/:id/api-keys` | Mint one. The **only** time the plaintext is returned |
| `PATCH /api/agents/:id/api-keys/:keyId` | Edit the description or expiry — never the credential |
| `DELETE /api/agents/:id/api-keys/:keyId` | Revoke. Guarded on "not already revoked" so a repeat call cannot re-audit |

`POST /agents/:id/regenerate-api-key` and `/regenerate-a2a-api-key` remain for CLI and
script compatibility.

---

## 4. Verification path

`validateGatewayAuth` takes an injected `verifyApiKey` rather than reading the
database itself, which keeps the middleware directly unit-testable. The routes supply
the channel-specific implementation — that injection **is** the channel isolation.

1. Prefix check against the channel. A mismatch is rejected without a query.
2. `SELECT … WHERE key_hash = ? AND agent_id = ? AND channel = ?` — a single indexed
   read, not a scan. The hash is unsalted (the input is already CSPRNG output), which
   is what makes the O(1) lookup possible and also makes the comparison constant-time.
3. Revoked → `Invalid token`. Expired → `API key expired`.
4. On success, `last_used_at` is stamped best-effort and never fails the request.

**Expiry and revocation are reported differently on purpose.** An expired key is an
operational problem the integrator can fix by rotating; folding it into a generic
failure sends them hunting for a credential bug that is not there. A revoked key stays
indistinguishable from one that never existed, so the endpoint is not an oracle for
which keys were once real. For the same reason, an expired key does **not** fall
through to the legacy-column check.

---

## 5. Run provenance

An API-key call has no user identity by design — keys identify *integrations*, not
people, so `runs.userId` stays NULL for these channels (see
[api-permissions.md](./api-permissions.md)). Run history would therefore show nothing
at all about who triggered a run.

The key's **description** fills that gap: it becomes the run's `triggerUserName`, and
is recorded on the channel context as `channel_info.api_key` (`{ id, name }`). This is
why `name` is a required field rather than an optional label.

On a trusted A2A hop the forwarded user identity still wins — there the key name is
recorded as provenance for *which integration relayed the call*, not as the identity.

---

## 6. Migration from the single-key columns

The legacy columns were plaintext, which is the **only** reason this migration can run
unattended: the hash is computable from what is already in the database, so no
integration has to rotate anything and nobody has to be told. That window closes for
good once the columns are cleared.

- **Phase 1 — backfill.** `backfillAgentApiKeys()` runs at boot (before `markReady`),
  inserting an `agent_api_keys` row per legacy key, named "Migrated key", never
  expiring. Idempotent: a key whose hash is already present is skipped, so a re-run is
  a no-op. Hashing happens in Node because neither SQLite nor a stock PostgreSQL can
  compute SHA-256 in SQL (pgcrypto is not guaranteed present).
- **Phase 2 — dual read.** `validateGatewayAuth` falls back to comparing the legacy
  column when the hashed lookup misses, so a row the backfill has not reached still
  authenticates. No request fails during or before the backfill.
- **Phase 3 — stop writing, then clear.** The regenerate endpoints create key rows
  instead of writing the column; a later migration nulls the columns and finally drops
  them. Only this last step is irreversible.

---

## 7. Security properties

- **Only the SHA-256 is stored.** A database read yields nothing usable. No salt — the
  input is already CSPRNG output, so there is nothing to precompute.
- **Channel isolation is enforced in the query**, not by a post-check. An `a2a` key
  presented to the REST gateway fails exactly as an unknown key would.
- **Creation, update and revocation are audited**; use is not, since that would write
  an entry per API call — `last_used_at` covers it. `details` carries the name and
  channel, never the key or its hash.
- **Revocation is scoped by `agentId`**, so a key id from another Agent is unreachable.
- **Zero active keys is fail-closed**: with `api_key` auth on and no key, every call is
  rejected. The Publish tab warns about this state explicitly rather than showing an
  empty table.
- **`last_used_at` is best-effort and throttled** to once a minute. It never fails the
  request that produced it, and a future stored value (clock skew, a restored backup)
  still stamps rather than freezing the field forever.
