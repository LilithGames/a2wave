# SCM Storage Invariants

SCM storage crosses API routes, environment bootstrap, container startup, Git,
P4, and two database dialects. A change is complete only when the invariants
below hold across every affected entry point.

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
  A failed cleanup is retried while the local workload owner and durable lease
  remain active, and one removal reservation stays continuously visible across
  filesystem retries. Queue capacity and binding/path guards are released only
  after cleanup succeeds.
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
- Reservation age is **not** proof of abandonment: multi-repository Git work
  and filesystem cleanup can outlive any per-command timeout, and a slow or
  partitioned peer may still be deleting. Single-process SQLite clears leaked
  rows synchronously before opening its port after restart. PostgreSQL retains
  an uncertain row; startup and the lease sweeper must never delete a peer's
  reservation merely by age. A live process retries its own failed release by
  exact attempt token. Crash leftovers use the explicit PostgreSQL operator
  recovery procedure, also fenced by the observed token.
  Graceful shutdown drains these exact-token release retries before closing the
  database, so a normal stop does not turn a transient release error into an
  operator-only recovery.
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
  pending in the owning lifecycle until it succeeds. Graceful shutdown drains
  those retries before closing the database; a permanent failure therefore
  reaches the non-zero shutdown timeout instead of being reported as a clean
  stop. The stale-lease sweeper is an additional recovery path: it releases a
  lease only when its workload is terminal (or its row deleted), nothing local
  still runs or cleans up the workload, and — for an active lease — this
  instance is the recorded owner. An active lease owned by another instance is
  never swept; a reserved lease never had a process and may be released on any
  replica. Both an owner retry and the sweeper nudge the affected Run queue after
  freeing capacity, so queued work does not wait for an unrelated trigger.
- PostgreSQL startup must not reset in-progress Run, Evaluation, sync, or index
  rows merely because another replica started. Without a positively identified
  dead owner, preserving a visible stuck lease is safer than reclaiming a checkout
  beneath a healthy peer. SQLite startup is the symmetric single-owner case: after
  failing interrupted workloads, it releases their durable leases explicitly.
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
