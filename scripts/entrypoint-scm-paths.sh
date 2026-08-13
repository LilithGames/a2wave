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
# It must also be PRE-CREATED by the entrypoint, not left to the API: the block
# that consumes this list deliberately leaves SCM_STORAGE_ROOT root-owned (the
# root is routinely an operator-owned host bind), so appuser cannot mkdir a
# child of it at runtime. Without the pre-create, the API's first reclaim fails
# with EACCES and every source deletion returns 503 with the row stuck pending.
#
# This name is duplicated from SCM_RECLAIM_DIR in
# apps/api/src/lib/scm-storage.ts — a shell script cannot import a TS constant.
# scripts/__tests__/entrypoint-scm-chown.test.mjs reads that constant and fails
# if the two ever drift, which is how the previous `.reclaiming` name survived a
# rename here while the API had already moved on.
SCM_MANAGED_SUBDIRS='sources workspaces .a2wave-scm-reclaim-v1'

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
}
