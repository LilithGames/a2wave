# Git Repository Trigger Channels (`glab` / `gh`)

Poll a repository through the vendor CLI and start a Run **only when a watched
merge/pull request actually moves**. Deliberate contrast with `schedule`, which
fires unconditionally and spends tokens on every tick even when nothing changed.

## Change detection

- Diff a **per-request fingerprint**: head SHA + comment count. Never an opaque
  payload hash — the fired event must name the exact request and transition.
- Because a merge request number is unique only **within** its repository, state
  under a wide scope is keyed `project!number`. Keying on the number alone made
  two repositories' `!42` the same entry.
- The per-request path is recorded **only** for the wide scopes. GitLab returns
  `references` on the single-project listing too, so attaching it there re-keyed
  every pre-existing fingerprint and made the first poll after an upgrade fire
  `opened` + `closed` for every open request.

## The channel does not answer itself

A review Agent subscribed to `commented` replies with `glab mr note` / `gh pr
comment` — which raises the very comment count `commented` is diffed from. Before
this guard the next poll read that as a new comment and ran again, and again,
braked only by the 30s interval floor and the 5-runs-per-tick cap. Discord and
Telegram already drop bot-authored messages; these channels now have the
equivalent.

- The forge login the CLI's token speaks as is read off `auth status`, which is
  already parsed for the config UI, so the common case costs **no** API call.
  `glab api user` / `gh api user` is the fallback for CLI versions whose report
  prints only "Token found".
- That login is memoised per `channel|host`. A config change (`stop()`) drops it;
  a one-hour TTL covers a token rotated under an unchanged config.
- The newest comment's author comes from the listing on GitHub — the GraphQL
  query asks each discussion collection for `last:1`, still one call per
  repository per tick. GitLab's merge request listing carries no such field, so
  the author is fetched from `merge_requests/:iid/notes` **only for a request
  whose comment count actually moved**, which the per-tick run cap bounds to five
  calls. These are not list pages and are not charged to the page budget.
- GitLab **system** notes ("added 1 commit") are skipped: they never move
  `user_notes_count`, so they are never the comment that fired the event.
- **Only a delta of exactly one comment can be suppressed.** The forges report
  the *newest* author, not every author in the delta, so a delta of 2 — a
  colleague commented and the Agent replied before the next poll — is fired even
  though the newest comment is the Agent's own. Suppressing it would advance the
  fingerprint past the colleague's comment and lose it for good; the cost of
  firing is the Agent seeing its own comment echoed in the prompt, which is the
  cheaper of the two failures. `diffRepoState` carries the size of the delta on
  the fired event as `newComments` for exactly this check.
- **Fails open.** An unresolvable account or author fires the Run. A missed review
  is a worse failure than a duplicate one, and the run cap still applies.
- Suppression still **advances the fingerprint**. Holding it back would re-detect
  the Agent's own comment on the next tick — the same loop, one layer down.

### Caveat: `updated` has no author filter

An Agent that *pushes* (a fixup commit, a rebase) re-triggers itself the same
way, and this is deliberately not covered: neither listing carries the head
commit's forge **login**, only a git author string that need not correspond to an
account. Resolving it would mean one call per changed request — the N+1 sweep
this channel exists to avoid. An Agent that writes to a branch it also watches
should therefore not subscribe to `updated` on that repository.

## CLIs are probed, never installed

- Absent from `provider-cli-lock.json`.
- Forge auth stays in the CLI's own keyring or environment.
- Therefore `glabConfig` / `ghConfig` hold **no credentials** and need no masking.

## Polling and ownership

- Repositories are polled **serially**.
- A poll **owns its channel via a token**, so a config change retires the running
  poll rather than racing it.

## Scopes

A watch entry has a **scope**:

- `project` — a single repository. Deliberately **does not page at all**.
- `group` (**GitLab only**) — names a namespace instead of enumerating
  repositories, so newly created repositories are picked up with no config edit.

Why GitLab only: GitLab serves both as the same record shape from two
collections, which is why one normalizer and one diff engine cover them. GitHub
has no org-wide query carrying head SHA and comment counts, so widening there
would mean the N+1 sweep this channel exists to avoid — the `gh` schema rejects it.

### Removed: instance-wide scope

Built and then removed. Measured against a real deployment it returned **402 open
requests across nine unrelated namespaces**, exhausting the whole tick page budget
on its own. It could therefore never prove the open set was seen, and `closed`
would have been permanently suspended.

## Staleness preflight

The poll sees an open request; the Run may only execute minutes later, behind
the queue and whatever runs precede it. A repository that merges within a minute
of opening therefore produces Runs whose subject is already merged — measured on
a real deployment, one such Run burned 25K input + 46K cached tokens to conclude
"already merged, nothing to review".

So a queued Run re-probes its own request before doing any work, and terminates
as **`cancelled`** if it left the open set. Three rules keep that from becoming a
new failure mode:

- Only for `opened` / `updated` / `commented`. A `closed`-event Run's subject is
  *supposed* to be gone.
- Only when the Run actually **queued**. An immediately-dispatched Run starts
  milliseconds after the listing, so probing it would double the channel's forge
  call volume to re-answer the question the poll just answered. The marker is
  written by `triggerRun`; absent (pre-existing rows) means probe, since one
  wasted call beats missing a stale Run.
- **Fails open** on every ambiguous verdict — CLI missing, timeout, non-zero
  exit, unparsable output, GitLab's transient `locked`. A broken probe must never
  cancel legitimate work.

The cancellation retries like any other terminal transition: callers invoke
`executeChatRun` as `void`, so a rejected write is an unhandled rejection that
would leave the row `running` with its concurrency slot pinned — and the orphan
reaper cannot recover it, because the instance is alive and heartbeating.

## Paging budget

- Wide scopes page up to `GIT_TRIGGER_MAX_PAGES`.
- Pages are spent from a **tick-wide** `GIT_TRIGGER_MAX_PAGE_BUDGET`, not per
  entry — otherwise the two caps multiply and the worst-case tick that
  `GIT_TRIGGER_MAX_REPOS` bounds (~100s) becomes ~500s against a 30s floor.
- Past the budget the listing is reported **incomplete**, so `closed` inference
  suspends rather than firing on partial evidence.
