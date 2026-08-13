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
- PostgreSQL startup must not reset in-progress Run, Evaluation, sync, or index
  rows merely because another replica started. Without a positively identified
  dead owner, preserving a visible stuck lease is safer than reclaiming a checkout
  beneath a healthy peer. SQLite startup is the symmetric single-owner case: after
  failing interrupted workloads, it releases their durable leases explicitly.
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
