#!/bin/sh
# Shared SCM storage path helpers, sourced by docker-entrypoint.sh.
#
# Extracted from the entrypoint so the decision "which paths does root take
# ownership of" is testable without root and without a real UID remap. The
# chown itself stays in the entrypoint; only the target selection lives here.

# The subtrees a2wave allocates beneath SCM_STORAGE_ROOT. Everything else under
# that root belongs to the operator: on the shipped Compose defaults the root is
# the /data/workspace bind mount, which is routinely a host directory used
# directly by whoever runs the stack.
#
# The reclaim root holds checkouts a DELETE has vacated but not yet deleted. It
# is a2wave's own, and the startup sweep must be able to remove its contents as
# appuser — so a UID remap that skipped it would strand those directories under
# the old owner forever, leaking exactly the space reclaim exists to recover.
#
# It must also be created and marked by the entrypoint, not left to the API: the
# entrypoint deliberately leaves SCM_STORAGE_ROOT root-owned (the root is
# routinely an operator-owned host bind), so appuser cannot mkdir a child of it
# at runtime. Without provisioning, the API's first reclaim fails with EACCES.
#
# This name is duplicated from SCM_RECLAIM_DIR in
# apps/api/src/lib/scm-storage.ts — a shell script cannot import a TS constant.
# scripts/__tests__/entrypoint-scm-chown.test.mjs reads that constant and fails
# if the two ever drift, which is how the previous `.reclaiming` name survived a
# rename here while the API had already moved on.
SCM_MANAGED_SUBDIRS='sources workspaces'
SCM_STORAGE_MARKER='.a2wave-owned-storage-root'
SCM_STORAGE_MARKER_CONTENT='a2wave-scm-storage-v1'
SCM_RECLAIM_SUBDIR='.a2wave-scm-reclaim-v1'
SCM_RECLAIM_MARKER='.a2wave-owned-reclaim-root'
SCM_RECLAIM_MARKER_CONTENT='a2wave-scm-reclaim-v1'

# The pre-managed-storage entrypoint persisted the verified CLI-home owner as
# `UID:GID`. Its marker is positive provenance that this is an a2wave-initialized
# home volume, rather than an arbitrary operator bind mounted at the same path.
scm_cli_home_marker_is_valid() {
  owner_marker="$1"
  [ -f "$owner_marker" ] || return 1
  [ -L "$owner_marker" ] && return 1
  case "$(cat "$owner_marker" 2>/dev/null || true)" in
    *[!0-9:]* | *:*:*) return 1 ;;
    [0-9]*:[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Releases before managed SCM storage did not set SCM_STORAGE_ROOT. Their
# private CLI-home volume nevertheless contains a2wave-created worktrees at
# ~/.a2wave/workspaces. Permit marker adoption only for that exact fallback;
# an explicitly configured path remains operator-owned even if it has the same
# spelling. The optional fourth argument makes the filesystem contract testable
# without requiring access to /home/appuser.
scm_legacy_storage_adoption() {
  scm_root="$1"
  root_was_set="$2"
  has_cli_home_marker="$3"
  legacy_root="${4:-/home/appuser/.a2wave}"
  if [ "$root_was_set" != "x" ] && [ "$has_cli_home_marker" = "true" ] &&
    [ "$scm_root" = "$legacy_root" ]; then
    printf '%s\n' true
  else
    printf '%s\n' false
  fi
}

scm_storage_is_owned() {
  scm_root="$1"
  marker="$scm_root/$SCM_STORAGE_MARKER"
  [ -d "$scm_root" ] || return 1
  [ -L "$scm_root" ] && return 1
  [ -f "$marker" ] || return 1
  [ -L "$marker" ] && return 1
  [ "$(cat "$marker" 2>/dev/null)" = "$SCM_STORAGE_MARKER_CONTENT" ]
}

# Claim only a mount whose managed names are all unused. The marker owns the
# names `sources/` and `workspaces/`, not the mount root or any sibling data.
# A pre-upgrade operator directory with either generic name is therefore never
# silently adopted or chowned.
scm_prepare_managed_storage() {
  scm_root="$1"
  allow_legacy_adoption="${2:-false}"
  [ -n "$scm_root" ] || return 1
  [ -L "$scm_root" ] && return 1
  mkdir -p "$scm_root" || return 1
  [ -d "$scm_root" ] || return 1

  if ! scm_storage_is_owned "$scm_root"; then
    marker="$scm_root/$SCM_STORAGE_MARKER"
    # An invalid marker belongs to the operator. Refuse before creating or
    # changing anything else.
    if [ -e "$marker" ] || [ -L "$marker" ]; then
      return 1
    fi
    # Older releases created only `workspaces/` below the private SCM root.
    # A pre-existing `sources/` therefore has no legacy a2wave provenance and
    # must remain operator-owned even when workspaces are eligible to migrate.
    legacy_sources="$scm_root/sources"
    if [ "$allow_legacy_adoption" = "true" ] &&
      { [ -e "$legacy_sources" ] || [ -L "$legacy_sources" ]; }; then
      return 1
    fi
    for scm_subdir in $SCM_MANAGED_SUBDIRS; do
      scm_dir="$scm_root/$scm_subdir"
      if [ -e "$scm_dir" ] || [ -L "$scm_dir" ]; then
        # Legacy Compose omitted SCM_STORAGE_ROOT while a2wave itself created
        # worktrees in its private ~/.a2wave volume. The entrypoint derives
        # this permission from that exact missing-variable fallback; callers
        # cannot use it for an explicitly configured operator bind.
        if [ "$allow_legacy_adoption" != "true" ] || [ -L "$scm_dir" ] || [ ! -d "$scm_dir" ]; then
          return 1
        fi
      fi
    done
    reclaim_root="$scm_root/$SCM_RECLAIM_SUBDIR"
    if [ -e "$reclaim_root" ] || [ -L "$reclaim_root" ]; then
      # An intermediate release may already have created the marker-owned
      # reclaim root. Never adopt an unmarked directory, even on a managed
      # volume, because startup recovery recursively deletes its contents.
      scm_reclaim_is_owned "$reclaim_root" || return 1
    fi
    (set -C; printf '%s\n' "$SCM_STORAGE_MARKER_CONTENT" > "$marker") 2>/dev/null ||
      scm_storage_is_owned "$scm_root" || return 1
  fi

  # With ownership established, missing children are recoverable from a crash
  # between marker creation and mkdir. Existing children must still be ordinary
  # directories; validate every one before the entrypoint performs any chown.
  for scm_subdir in $SCM_MANAGED_SUBDIRS; do
    scm_dir="$scm_root/$scm_subdir"
    [ -L "$scm_dir" ] && return 1
    if [ -e "$scm_dir" ] && [ ! -d "$scm_dir" ]; then
      return 1
    fi
  done
  for scm_subdir in $SCM_MANAGED_SUBDIRS; do
    mkdir -p "$scm_root/$scm_subdir" || return 1
  done
}

scm_reclaim_is_owned() {
  reclaim_root="$1"
  marker="$reclaim_root/$SCM_RECLAIM_MARKER"
  [ -d "$reclaim_root" ] || return 1
  [ -L "$reclaim_root" ] && return 1
  [ -f "$marker" ] || return 1
  [ -L "$marker" ] && return 1
  [ "$(cat "$marker" 2>/dev/null)" = "$SCM_RECLAIM_MARKER_CONTENT" ]
}

# Create the reclaim root only when the name is genuinely unused. Existing
# directories require the exact marker and are otherwise left byte-for-byte
# untouched for the operator to inspect or move.
scm_prepare_reclaim_root() {
  scm_root="$1"
  scm_storage_is_owned "$scm_root" || return 1
  reclaim_root="$scm_root/$SCM_RECLAIM_SUBDIR"
  if [ -e "$reclaim_root" ] || [ -L "$reclaim_root" ]; then
    if scm_reclaim_is_owned "$reclaim_root"; then
      return 0
    fi
    # mkdir and marker creation cannot be one filesystem operation. The parent
    # storage marker reserves this exact name, so an ordinary empty directory
    # is the recoverable result of a crash between those two operations. Never
    # adopt a symlink, non-directory, or a directory containing any data.
    [ -L "$reclaim_root" ] && return 1
    [ -d "$reclaim_root" ] || return 1
    if ! reclaim_entry="$(find "$reclaim_root" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)"; then
      return 1
    fi
    [ -z "$reclaim_entry" ] || return 1
    (set -C; printf '%s\n' "$SCM_RECLAIM_MARKER_CONTENT" > "$reclaim_root/$SCM_RECLAIM_MARKER") 2>/dev/null ||
      scm_reclaim_is_owned "$reclaim_root" || return 1
    scm_reclaim_is_owned "$reclaim_root"
    return
  fi
  mkdir "$reclaim_root" || return 1
  printf '%s\n' "$SCM_RECLAIM_MARKER_CONTENT" > "$reclaim_root/$SCM_RECLAIM_MARKER"
}

# Print the paths the UID remap may chown, one per line.
#
# Emits only existing, non-symlink managed subtrees, and never the root itself.
# A symlink is skipped rather than chowned: appuser can write inside the
# persisted volume, so a symlinked `sources` pointing outside the mount would
# otherwise let root hand ownership of the target to appuser on the next boot.
#
# The same rule applies to the root one level up. The entrypoint separately
# refuses to start on a symlinked root, but emitting nothing here is what makes
# the order safe regardless: a caller that sweeps before validating would
# otherwise chown the link target's real subtrees and only then exit.
scm_chown_targets() {
  scm_root="$1"
  [ -n "$scm_root" ] || return 0
  # -L before -d: a symlink to a directory satisfies -d, so order matters.
  [ -L "$scm_root" ] && return 0
  [ -d "$scm_root" ] || return 0
  scm_storage_is_owned "$scm_root" || return 0

  for scm_subdir in $SCM_MANAGED_SUBDIRS; do
    scm_dir="$scm_root/$scm_subdir"
    # -L before -d: a symlink to a directory satisfies -d, so the order matters.
    if [ -L "$scm_dir" ]; then
      continue
    fi
    if [ -d "$scm_dir" ]; then
      printf '%s\n' "$scm_dir"
    fi
  done

  reclaim_root="$scm_root/$SCM_RECLAIM_SUBDIR"
  if scm_reclaim_is_owned "$reclaim_root"; then
    printf '%s\n' "$reclaim_root"
  fi
}
