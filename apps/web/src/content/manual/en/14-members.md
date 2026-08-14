# Member Management

Agents support multi-person collaboration. An owner can invite other users to access the Agent as a **viewer** or **editor**, with permission boundaries enforced in the backend guard layer rather than relying on frontend hiding. Typical scenarios: multiple people maintaining the same Agent without sharing an account / API Key; graded access as needed (some edit the prompt and publish, others read-only + debug); fully auditable changes.

## Roles and permission matrix

| Action | viewer | editor | owner | admin |
|------|:---:|:---:|:---:|:---:|
| View details / config (redacted) | ✅ | ✅ | ✅ | ✅ |
| View chat history / runs | ✅ | ✅ | ✅ | ✅ |
| Chat debug | ✅ | ✅ | ✅ | ✅ |
| Edit config (prompt/skill/mcp/env) | ❌ | ✅ | ✅ | ✅ |
| Publish / stop / resume / reset Key | ❌ | ✅ | ✅ | ✅ |
| Clone / share | ❌ | ✅ | ✅ | ✅ |
| Delete Agent | ❌ | ❌ | ✅ | ✅ |
| Manage members (add/edit/remove) | ❌ | ❌ | ✅ | ✅ |

> **owner** = the Agent's creator; **admin** equals owner on all Agents. editor/viewer are recorded in the members table, and the same user cannot be authorized more than once on the same Agent.

## Managing members in Web

1. Top-right "More actions" on the Agent detail page → **Member Management** (visible only to owner / admin).
2. In the dialog:
   - **Add member**: search by username or email (300ms debounce) → select → choose role → add.
   - **Change role**: switch viewer / editor via the dropdown on the member row; takes effect immediately.
   - **Remove member**: click the trash icon → confirm again.
3. When logged in to that Agent as viewer/editor: viewer has the save/delete buttons disabled and no member-management entry; editor can save/publish/clone, but delete and member management remain hidden.

## Managing via CLI (a2wave)

```bash
a2wave agents members list <agent>
a2wave agents members add <agent> --user alice --role editor
a2wave agents members add <agent> --user alice@example.com --role viewer
a2wave agents members update <agent> --user alice --role viewer
a2wave agents members remove <agent> --user alice
```

`--user` accepts a `usr_` ID / username / email: anything not starting with `usr_` goes through user lookup — 0 matches errors out, multiple matches prompts you to specify precisely with `usr_xxx`.

## Visibility and status codes

- When opening an Agent, the response includes `meta.permission`, which the frontend uses to control button visibility.
- `GET /api/agents` only returns Agents you own or can see as a member.

| Scenario | Return |
|------|------|
| Invisible Agent (not owner/admin/member) | **404** (does not leak existence) |
| Visible but insufficient write permission | **403** |
| Adding a duplicate member | **409** |
| Adding yourself / adding the owner / adding a member to an ownerless Agent / user does not exist | **400 / 404** |

## Inviting a new colleague (admin)

Administrators no longer create accounts by typing someone else's password. New accounts go through an **invitation link**: the admin issues a link, and the recipient sets their own username, email and password. The password is therefore known only to its owner, and every account is guaranteed to carry an email address (which corporate identity alignment later depends on).

**Admin side** (sidebar → Users → **Invite user**):

1. Optionally pin an **email**. If set, only that address can register with the link, so forwarding it does not transfer the invitation; leave it empty to let the invitee supply their own.
2. Pick a **role** (user / admin) and a **validity period** (1 / 3 / 7 days, default 3).
3. Optionally add a **note** — admin-only, e.g. which team they join.
4. Click **Create invite link**, copy it, and send it over your usual IM.

The dialog stays open on success: the full link is shown only there, so copy it before closing. You can also copy or revoke it later from **Invitations** (the button at the top of the Users page, at `/users?view=invitations` — bookmark it or send it to another admin).

**Invitee side**: open the link → fill in username, email, display name (optional), password and confirmation → submitting creates the account and **signs them in immediately**, with no second trip through the login page.

> [!TIP]
> A **company email** is recommended: when SSO is enabled, the platform aligns local accounts with corporate identities by email, so a personal address leaves one person with two accounts.

**Edge cases**:

| Situation | What happens |
|------|------|
| Link expired | Shows "Invitation link expired" and no registration form; ask an admin for a new one |
| Revoked by an admin | Shows "Invitation link revoked" |
| Link already used | Shows "Invitation already used" — invitations are single-use |
| Truncated or bogus code | Shows "Invalid invitation link" |
| Re-inviting the same email | The previous link is retired automatically, so only the newest one works |
| Email already registered | Rejected at issue time, rather than when the recipient opens the link |
| Username or email taken | Reported on submit; pick another — the invitation link stays usable |

> [!IMPORTANT]
> The invitation link is itself a credential: whoever holds it can create an account. Send it through a trusted channel and never post it in a public channel. Revocation takes effect immediately.

## Disabling a leaver (admin)

Member management above only unbinds permissions on a *single* Agent. To revoke someone's access to the whole platform at once, use **Disable** on the **Users** page (sidebar → Users, admin only).

1. Find the account in the list → click **Disable** → confirm.
2. A disabled account is signed out immediately and can no longer log in with a password, log in via SSO, invoke any Agent through OAuth, or re-obtain access to an "SSO-verified" share page. The row is dimmed and the status column reads "Disabled".
3. Click **Enable** to restore access unchanged.

> [!TIP]
> Prefer disabling over deleting when someone leaves: it is reversible, and it keeps audit-log entries pointing at a real account. Deletion is for cleaning up accounts created by mistake.

> [!IMPORTANT]
> The system always keeps at least one usable administrator: disabling the last active admin is rejected, and you cannot disable yourself.

Disabling does **not** stop Agents that user published — an Agent is a team asset and should not silently go offline because its creator left. To take one out of service, stop that Agent explicitly.

> [!WARNING]
> Disabling revokes only **account-bound** access: sign-in, SSO, OAuth invocation, and share pages. **Account-independent** entry points are unaffected — an Agent API Key belongs to the Agent, not to a person, and the same goes for an Agent published without authentication. When someone leaves, **rotate the API Key** on their Agents too.
>
> Also note that a browser already holding a share-viewer cookie can keep viewing until it expires (2 hours); disabling blocks re-obtaining one.

## Notes

- **Cloning automatically clears credentials**: an editor can also clone; the clone belongs to the cloner, and all `sensitive` env and Provider credentials are cleared (`authMode` is retained to prompt refilling).
- **Run isolation unchanged**: Runs produced by a member's debugging are still isolated by caller; the owner does not automatically see members' debug runs.
- Member add/edit/remove are logged to the audit log (viewable by admins only on the audit page).
- Owner transfer, team/organization entities, and cross-Agent permission inheritance are not supported.

## Related

- [Agent Management](/wiki/agents) · [Runs](/wiki/runs)
