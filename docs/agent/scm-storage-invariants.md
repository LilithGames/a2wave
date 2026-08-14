# SCM Storage Invariants

SCM storage crosses API routes, environment bootstrap, container startup, Git,
P4, and two database dialects. A change is complete only when the invariants
below hold across every affected entry point.

## The model: marks, liveness, convergence

Three ideas carry most of the weight here; the detailed rules below are their
consequences.

**Durable marks, not in-process state.** Two mirrored tables arbitrate a
worktree across replicas: a *workload lease* says "a workload may be using this
directory", a *removal reservation* says "a remover is about to delete this
one". Both are committed under the SCM mutation lock *before* their action, so
the lock's total order guarantees any interleaving observes at least one of
them. In-process mutexes cannot close that window by construction — the peer
that would need to observe them is another process.

**Liveness comes from heartbeats, never from age.** A mark's age proves
nothing: multi-repository Git work and filesystem cleanup routinely outlive any
per-command timeout, so a slow-but-healthy owner looks exactly like a dead one.
What does distinguish them is a heartbeat that stopped. Every process renews an
`instance_heartbeats` row, and an owner counts as dead when it has no row, its
heartbeat stopped past the threshold, or it booted *after* the mark was written
— the last case being a reused instance id (a container restart under the same
`HOSTNAME`) whose previous life wrote the mark. Never infer death any other
way, and never touch the mark of an instance that is still beating.

The owner fail-stops before peers reach that verdict. One minute before the
five-minute peer-death threshold, a process with no successful renewal
irreversibly pauses admission/promotion and enters graceful shutdown, which
terminates every Agent CLI before deleting its heartbeat. A late successful
write cannot revive that process's ownership: peers may already be preparing to
reclaim it, so reacquisition requires a new process lifetime. This deliberate
deadline margin is the fencing mechanism; it avoids spreading an ownership
epoch through every filesystem call while still ordering owner exit before peer
recovery.

The margin is a budget, and every term in it is a constant in a different file:
detection can take one beat interval, shutdown has a hard deadline, and each
Agent CLI gets a SIGTERM→SIGKILL grace. Their sum must stay below the margin, so
`__tests__/fail-stop-timing.test.ts` asserts it — raising the shutdown timeout
without it would silently let a fenced owner outlive its own eviction. The
deadline timer is deliberately **not** `unref`'d on this path: fail-stop is
self-initiated, and its usual cause (an unreachable database) is also what can
wedge a drain, so nothing else guarantees the exit.

Fail-stop is a **floor, not a door check**. Admission alone is not enough: SCM
sync and CodeGraph indexing spawn their own child processes — invisible to the
engine registry's reaper — and hold the checkout for minutes; an evaluation
replays case after case long past its single admission check; and workspace
removal would force-delete a worktree a peer may already own. Each of those
consults the fence itself, and shutdown also stops the auto-sync timers, which
is what actually aborts those child processes.

Two consequences worth stating plainly, because both are load-bearing tradeoffs
rather than oversights:

- **The first heartbeat is awaited and fatal.** A database blip during boot
  refuses startup rather than serving; there is no retry, so the orchestrator's
  restart backoff owns it. Serving first would mean admitting a Run and
  activating a lease while no peer can see this instance is alive, and a peer
  past its grace window would then reap that live workload.
- **A shutdown that hits its hard deadline leaves the heartbeat row behind.**
  Peers then wait out the full staleness threshold instead of reclaiming
  immediately. That is the safe direction — late reclamation, never early — but
  it means a wedged shutdown costs five minutes of that source's availability.

Recovery of *peers* therefore stays disabled for one staleness window after
boot: immediately after an upgrade the table is empty, so every peer would read
as dead and this replica would reclaim checkouts out from under processes that
have simply not written their first row yet. A process's own marks, and any
reservation explicitly handed off with a NULL owner, need no such wait — no
liveness has to be inferred for either.

**Convergence is periodic, not inline.** Removing a worktree is a filesystem
operation that can fail for reasons the caller cannot fix (a handle the exited
CLI has not released, a busy mount). The owner tries inline for a bounded
window because it is the fastest path while the failure is transient, then
hands the reservation off; a periodic reconciler adopts every reservation with
no live owner and retries. A failed attempt keeps the reservation and the next
tick tries again — **that is the retry loop**, which is why no operation path
needs an unbounded one. The reservation, not the retrying process, is what
keeps other actors off the worktree, so handing off frees the concurrency slot
and Agent binding without reopening any race.

Two directions this deliberately does *not* go, and the reason each is worth
revisiting when this area is next touched:

- **Fewer shared writable directories beats better arbitration of them.** Today
  seven kinds of actor (chat run, evaluation, manual delete, TTL cleanup,
  ephemeral cleanup, sync/index, source mutation) can contend for one checkout,
  and the invariant surface is roughly *actors × shared directories*. Giving
  every Git workload its own worktree — as evaluations already do with
  `eval-<taskId>` — would collapse most of that matrix, leaving the base
  checkout with a single writer. P4 cannot follow: a client spec binds one
  server-side `Root`, so its checkout is shared by construction and the
  serialization here is the only available answer.
- **Not sharing workspace storage between replicas beats coordinating it.**
  Pinning a source's workspaces to one replica, or giving each replica its own
  volume, would remove the cross-replica arbitration problem rather than solve
  it. The durable marks exist because the storage is shared; they are the cost
  of that choice, not a permanent requirement.

## Path ownership

- `localPath` is the source checkout; `workspacesPath` is the Git worktree root.
  They must never overlap each other or either path owned by another source.
- Compare filesystem identity, not only path strings. Existing symlinks and the
  case behavior of the mounted filesystem are part of path identity.
- A source may live below the managed allocation roots, but it may never claim
  the shared `sources/` or `workspaces/` root itself — as **either** `localPath`
  or `workspacesPath`. A claimed `workspaces/` root is the wider outage: every
  later source's default allocation is a descendant of it, so the peer scan
  rejects each one and managed allocation stops deployment-wide, with no in-app
  repair because PATCH validates through the same planner.
- Git may use managed storage. P4 requires an explicit path covered by the
  configured Client Root or AltRoots.
- Create, path-changing PATCH, and environment bootstrap must plan paths through
  the same policy while holding the same mutation lock. The peer scan and write
  are one critical section: SQLite uses the process transaction lock and
  PostgreSQL uses a transaction-scoped advisory lock.

## Upgrade compatibility

- Existing bind mounts must remain visible after an image or Compose upgrade.
- A legacy NULL `workspaces_path` is pinned once at boot. If the source's old
  `~/.a2wave/workspaces/<suffix>` directory exists, that exact directory wins;
  otherwise the current managed default is stored.
- Saved legacy roots remain valid, visible, and reclaimable. Never infer that an
  arbitrary operator path is managed merely because it is below a broad root.
- Legacy Compose files omit `SCM_STORAGE_ROOT` and therefore fall back to the
  private `/home/appuser/.a2wave` volume where older releases created Git
  worktrees. The entrypoint may marker-adopt `workspaces/` only when that exact
  absent-variable fallback also carries the valid CLI-home ownership marker
  written by the legacy entrypoint. Older releases never created `sources/`,
  so any pre-existing directory with that name is refused. An explicitly
  configured root, including one with the same path string, remains
  operator-owned and receives no such exception.
- Changes to defaults require an upgrade fixture with both the old database row
  shape and the old on-disk layout.

## Lifecycle and audit

- Every enabled source with no completed initial sync starts or retries one
  checkout independently of recurring `autoSync`.
- PATCH and DELETE may cancel an automatic initial checkout. Periodic sync and
  indexing keep the busy guard; weakening it risks concurrent checkout damage.
- An Agent cannot release or replace its SCM binding while one of its Runs or
  Evaluations is admitted. Admission and binding mutation share the same
  cross-dialect mutation transaction. A durable SCM workload lease records the
  actual executing Agent and source before queue admission, remains through the
  terminal-status-to-process-exit cleanup window, and is released only after
  workspace cleanup. RunSteps still identify the actual executing Agent when it
  differs from the Run initiator. A stale pre-admission Agent snapshot must never
  resolve the checkout after its binding changes.
- The lease names both sides of the relation, and **source-side mutations must
  consult it keyed by source**, not only by Agent rows: a path-changing PATCH,
  config-changing PATCH, source DELETE, workspace DELETE, and an env bootstrap
  update all refuse or defer while a durable lease pins the source. Config is
  part of the cleanup topology (single-repository versus multi-repository), so
  changing it under a workload is as unsafe as moving a path. Row state alone
  disagrees with the lease in exactly the windows that matter — an Evaluation
  writes no `runs` row yet owns an `eval-<taskId>` worktree, and a Run's lease
  outlives its terminal status until cleanup.
- Every worktree removal — manual DELETE, TTL/LRU cleanup, and ephemeral
  Run/Evaluation cleanup alike —
  goes through **one guarded protocol** (`removeSourceWorkspaceGuarded`), and
  worktree lifecycle is arbitrated cross-replica by a **durable removal
  reservation** (`scm_workspace_removals`), the mirror image of the workload
  lease: the lease says "a workload may be using this directory", the
  reservation says "a remover is about to delete this one". Both marks commit
  under the SCM mutation lock BEFORE their action, so the lock's total order
  guarantees any interleaving observes at least one of them — a workload
  admitted before the removal's re-check is seen via its lease; one admitted
  after reads the committed reservation at its creation gate and refuses.
- The protocol's shape: one DB-only transaction runs the occupancy decision
  and, only when it passes, commits the reservation; the removal itself runs
  outside any database transaction (a transaction spanning git I/O on the
  shared SQLite connection absorbs unrelated bare writes and erases them on
  rollback), inside the per-worktree mutex, with a `beforeRemove` re-check of
  the same decision immediately before the filesystem work. The decision
  re-reads the source row and refuses when its paths no longer match the
  removal target — a freed root may already belong to another source — with
  the registered-worktree assertion as the filesystem-level backstop. The
  reservation is released in `finally`.
- Ephemeral cleanup may exclude only its own workload, through the narrow owned
  cleanup API. The reservation transaction first proves that the exact durable
  lease is active on this process instance and pinned to this source; its own
  Run row and lease are then excluded while every other occupant still blocks.
  A failed cleanup is retried inline while the local workload owner and durable
  lease remain active, and one removal reservation stays continuously visible
  across filesystem retries.
- **Inline cleanup retries are bounded and end in a handoff, not in success.**
  The owner retries for roughly a minute of capped backoff, then sets
  `owner_instance_id` to NULL and returns; the reconciler owns the removal from
  there. Queue capacity and the binding/path guards are released at that point
  even though the worktree may still exist — the reservation is what keeps every
  counter-party off it, and holding a concurrency slot open for an undeletable
  directory costs the Agent a slot permanently for no added safety. A handed-off
  reservation must never be released by the handing-off process; if the handoff
  write itself fails, the row keeps naming that instance and the reconciler
  adopts it once the instance stops beating.
- The reservation is recognized by every counter-party: worktree resolution
  refuses to create or reuse a reserved name; run admission rejects a run
  whose explicit `worktreeConfig.name` is reserved; path PATCH, source DELETE,
  and env bootstrap return 409 / defer while one is pending. A second removal
  of the same worktree loses the stable target-id / `(source, workspace)`
  unique conflict. A separate opaque attempt token fences release and recovery,
  so a delayed current-version `finally` cannot delete a newer reservation for
  the same target. The attempt-token migration is intentionally non-rolling:
  **mixed-version operation is unsupported**. Stop all pre-attempt-token API
  replicas before applying the workspace-removal migrations, then start only
  the upgraded version; an old writer still deletes by stable id alone.
- The **heartbeat migration is non-rolling for the same reason, and for a
  sharper one**: a pre-heartbeat replica writes no `instance_heartbeats` row, so
  an upgraded replica reads it as dead and would reclaim leases and reservations
  out from under a process that is very much alive. Stop every replica before
  upgrading; do not run mixed versions even briefly.
- Reservation age is **not** proof of abandonment: multi-repository Git work
  and filesystem cleanup can outlive any per-command timeout, and a slow or
  partitioned peer may still be deleting. **A stopped heartbeat is** — see the
  liveness rule above. A reservation is therefore adoptable when its owner is
  NULL (an explicit handoff) or its owner is provably dead; a beating owner's
  reservation is never touched, because adopting it would run a second
  concurrent filesystem removal against the same worktree.
- Adoption is a **compare-and-set on the attempt token** under the SCM mutation
  lock, which stamps a fresh token, a new owner, and a new `attempt_started_at`.
  Two reconcilers racing on one row therefore produce exactly one filesystem
  operation. `attempt_started_at` is per *attempt*, not per target: liveness is
  judged against the attempt an owner actually started, or an adopted row would
  keep the original creation time and re-trip the boot-instant fence forever.
- The reconciler re-runs the **same occupancy decision** every remover runs, and
  releases the row as obsolete rather than removing when the worktree became
  legitimately occupied again or its source is gone. Holding an obsolete
  reservation is not "safe by default" — it blocks that source's path mutations
  and worktree creation indefinitely.
- Single-process SQLite still clears leaked rows synchronously before opening
  its port after restart: a restart proves the previous owner is gone, which is
  strictly faster than waiting out a staleness threshold. A live process retries
  its own failed release by exact attempt token, and graceful shutdown drains
  those retries before closing the database — then deletes its own heartbeat
  row last, so anything a failed drain leaked becomes immediately adoptable
  instead of waiting for the threshold.
- A leased Run whose `workDir` is still NULL blocks every worktree of the
  source: it has not chosen its directory yet and may resolve to the one being
  deleted.
- Occupied concurrency slots are a **union by run id** across the three
  occupancy views (`runs.status = 'running'`, in-process execution leases,
  durable active leases). The views overlap but none subsumes another — a
  terminal run still holding its active cleanup lease plus a `running` run
  whose lease is merely reserved are two occupied slots, which a max() of the
  counts reports as one. **Admission and queued-run promotion share this exact
  count** (`countOccupiedSlots`); fixing one side and not the other just moves
  the over-admission to the promotion path.
- Run admission counts durable **active** leases toward `maxConcurrency`
  alongside the runs table and the in-process registry. The in-process registry
  is empty on every other replica, and a run in its cleanup window is no longer
  `running` in the runs table; the active lease is the only cross-replica record
  of that window. Reserved-phase leases are queued work, not occupied slots, and
  a lease whose run row was deleted outright is sweeper input, not occupancy.
- Lease release after cleanup may fail transiently, and that failure must remain
  pending in the owning lifecycle until it succeeds. Unlike workspace removal,
  this retry stays unbounded: it is a pure database write holding no filesystem
  resource, and graceful shutdown drains it, so a permanent failure reaches the
  non-zero shutdown timeout instead of being reported as a clean stop.
- The stale-lease sweeper is an additional recovery path: it releases a lease
  only when its workload is terminal (or its row deleted), nothing local still
  runs or cleans up the workload, and — for an active lease — **this instance is
  the recorded owner or that owner is provably dead**. A lease owned by a
  beating peer is never swept; a reserved lease never had a process and may be
  released on any replica. Releases nudge the affected Run queue *and* the
  Evaluation queue after freeing capacity — evaluations run one per Agent, so a
  leaked evaluation lease stalls that Agent's entire queue until an unrelated
  trigger arrives.
- **A dead owner's non-terminal workload is failed, not left running.** The
  sweep only releases leases of terminal workloads, so a crashed instance would
  otherwise pin its Agent binding and slot forever behind a Run stuck at
  `running`. A companion pass applies exactly what that instance's own restart
  would have applied — the Run fails with a retryable structured reason and its
  A2A task is synced, the Evaluation task fails — and runs *before* the sweep so
  the same tick releases what it just settled. Run status/result/steps and
  Evaluation task/results/audit commit atomically; if any database write fails,
  the workload remains non-terminal and the next tick retries the whole
  settlement rather than releasing a half-written terminal state.
- PostgreSQL startup must still not reset in-progress Run, Evaluation, sync, or
  index rows merely because another replica started: another replica booting
  says nothing about a peer. Recovery of a peer's work is the heartbeat-driven
  reaper's job, not startup's. SQLite startup is the symmetric single-owner
  case: after failing interrupted workloads, it releases their durable leases
  explicitly.
- Environment bootstrap is a true upsert under the same rule: an env-driven
  source row that already matches the environment gets no write, sync state is
  reset only when the checkout's inputs (config or localPath) actually changed,
  and a row a peer replica is syncing or indexing defers the env change to the
  next boot. The busy predicate on the UPDATE is unconditional — a pure
  workspacesPath pin skips the sync-state reset but must not rewrite a row a
  peer's sync just acquired either — and a durable workload lease on the source
  defers the update the same way, because the lease may protect a checkout on a
  replica this process cannot observe.
- Graceful shutdown pauses both queue admission and queued-task promotion before
  stopping producers. It closes the database only after Run/Evaluation process
  exit, workspace cleanup, durable lease release, and audit drains settle.
- Cancellation is not a sync failure and must not emit a failure notification.
- DELETE is a durable two-phase operation. Its first transaction writes
  `deletion_requested_at` plus `deletion_requested_by`, disables the source,
  and writes `scm_source.request_deletion`; the source row remains as a path
  reservation until filesystem reclaim succeeds. No filesystem operation may
  run before that transaction commits.
- After the reservation commits, exact managed paths may be atomically renamed
  into `.a2wave-scm-reclaim-v1/` and recursively removed. Legacy worktrees are
  parked in the identically named private root beside the legacy `workspaces/`
  directory so `rename(2)` stays on the CLI-home volume instead of failing with
  `EXDEV` against the managed workspace volume. Only then may a second
  transaction atomically write `scm_source.delete` and delete the source row.
  A failure leaves the reservation for a retry rather than losing either the
  row-to-checkout relationship or the terminal audit entry. Recovery attributes
  the terminal entry to `deletion_requested_by`, never to the source owner.
- Startup recovery is database-directed: only rows with a durable deletion
  reservation authorize cleanup. Never sweep the reclaim directory by filename.
  A transaction rollback or an unmarked directory must preserve its contents.
- Every reclaim root requires the a2wave ownership marker. An empty unmarked
  reclaim root beneath a marker-owned storage root is the one recoverable state:
  it is the crash boundary between `mkdir` and marker creation and may be marked
  on the next boot. Any non-empty or invalid root remains operator-owned. The planner, runtime
  workspace validation, and sync backstop reject any source path overlapping
  that root. An existing non-empty operator directory is never adopted.
- Reclaim only exact id-derived managed paths, including the exact legacy
  worktree path. Never recursively delete an operator-chosen path or a symlink,
  and never vacate a path that still overlaps a surviving peer — legacy rows can
  nest a worktree root inside another source's checkout.
- A peer-blocked managed path keeps the deletion reservation. Isolation reports
  blocked paths instead of silently skipping them, and neither the DELETE route
  nor startup recovery finalizes the row while any remain: the id-derived
  directory has no other name, so deleting the row would orphan it with nothing
  able to retry. The deletion retries after the occupying peer is removed.
- The legacy `.reclaiming/` name is not swept, created, or chowned by anything.
  Existing operator data with that name remains untouched during upgrade.

## Container ownership

- The entrypoint may create and own `sources/`, `workspaces/` and a newly
  created reclaim root beneath `SCM_STORAGE_ROOT` only when the storage root
  carries the exact a2wave ownership marker. It must not chown the mount root,
  unrelated contents, or pre-existing generic directories. An unmarked root
  containing any reserved child is refused, not adopted.
- Every directory the API must create children in has to be pre-created here.
  Because the mount root stays root-owned, appuser cannot mkdir a child of it at
  runtime: a managed subtree missing from the entrypoint's list fails with
  EACCES on first use, which for the reclaim root means every source deletion
  returns 503 with the row stuck in the pending reservation. The shell list and
  `SCM_RECLAIM_DIR` are pinned together by
  `scripts/__tests__/entrypoint-scm-chown.test.mjs`.
- The same rule applies to named volumes, Docker-created root-owned binds, and
  explicit user-owned binds.
- Refuse symlinked roots or managed children before any traversal or ownership
  change.

## Required change matrix

For every SCM storage change, mark each applicable cell in the PR description:

| Entry point | Git | P4 | SQLite | PostgreSQL |
|---|---:|---:|---:|---:|
| Create | | | | |
| PATCH / enable-disable | | | | |
| DELETE | | | | |
| Startup recovery / upgrade | | | | |
| Environment bootstrap | | | | |

Also state the tested mount mode: named volume, default bind, explicit bind,
and macOS Docker Desktop bind where applicable.

The executable cross-dialect and container checks live behind
`pnpm test:scm-storage`. CI runs the same command in the
`scm-storage-integration` job.
