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
  the shared `sources/` or `workspaces/` root itself.
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
- Cancellation is not a sync failure and must not emit a failure notification.
- Deleting a source row and writing `scm_source.delete` commit atomically. The
  filesystem reclaim runs after commit and has its own outcome audit.
- Reclaim only exact id-derived managed paths, including the exact legacy
  worktree path. Never recursively delete an operator-chosen path or a symlink.

## Container ownership

- The entrypoint may create and own `sources/` and `workspaces/` beneath
  `SCM_STORAGE_ROOT`; it must not chown the mount root or unrelated contents.
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
