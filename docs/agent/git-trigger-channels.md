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
