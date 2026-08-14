#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTEGRATION_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/a2wave-scm-storage-XXXXXX")"
SQLITE_ROOT="$INTEGRATION_ROOT/sqlite"
POSTGRES_ROOT="$INTEGRATION_ROOT/postgres"
IMAGE_NAME="${SCM_STORAGE_TEST_IMAGE:-a2wave:scm-storage-test}"
VOLUME_NAME="a2wave-scm-storage-${RANDOM}-$$"

cleanup() {
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  case "$INTEGRATION_ROOT" in
    "${TMPDIR:-/tmp}"/a2wave-scm-storage-*)
      rm -rf -- "$INTEGRATION_ROOT" 2>/dev/null || {
        command -v sudo >/dev/null 2>&1
        sudo -n rm -rf -- "$INTEGRATION_ROOT"
      }
      ;;
    *)
      echo "Refusing to clean unexpected integration root: $INTEGRATION_ROOT" >&2
      exit 1
      ;;
  esac
}
trap cleanup EXIT

run_database_test() {
  local database_url="$1"
  local root="$2"
  mkdir -p "$root"
  (
    cd "$REPO_ROOT/apps/api"
    NODE_ENV=test \
      AUTH_SECRET=scm-storage-integration-secret \
      DATABASE_URL="$database_url" \
      SCM_INTEGRATION_ROOT="$root" \
      pnpm exec tsx scripts/scm-storage-integration.ts
  )
}

run_database_test "$SQLITE_ROOT/a2wave.db" "$SQLITE_ROOT"

if [[ -n "${SCM_STORAGE_POSTGRES_URL:-}" ]]; then
  run_database_test "$SCM_STORAGE_POSTGRES_URL" "$POSTGRES_ROOT"
else
  echo "SCM_STORAGE_POSTGRES_URL is unset; skipping the PostgreSQL half" >&2
fi

if [[ "${SCM_STORAGE_SKIP_DOCKER:-false}" == "true" ]]; then
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Docker ownership matrix requires Linux UID semantics; skipping on $(uname -s)" >&2
  exit 0
fi

if [[ "${SCM_STORAGE_BUILD_IMAGE:-true}" == "true" ]]; then
  # Not quiet on failure: the image pulls a pinned p4 binary from an external
  # CDN, so a build error here is often third-party availability rather than
  # anything about the storage semantics this gate exists to check. Surfacing
  # the real output is what tells those two apart.
  if ! build_log="$(docker build -q -t "$IMAGE_NAME" "$REPO_ROOT" 2>&1)"; then
    echo "$build_log" >&2
    echo "" >&2
    echo "Image build failed before the ownership matrix could run." >&2
    echo "If the failure is the p4 download, it is an upstream CDN outage, not a" >&2
    echo "regression here — re-run, or set SCM_STORAGE_BUILD_IMAGE=false against" >&2
    echo "an image you built earlier." >&2
    exit 1
  fi
fi

# The reclaim root must be covered too, and specifically as a *mkdir* rather
# than a touch: DELETE moves a vacated checkout into a subdirectory of it, and
# the entrypoint leaves SCM_STORAGE_ROOT itself root-owned, so a reclaim root
# that was never pre-created cannot be created by appuser at runtime. That gap
# made every source deletion fail with a 503 while this gate stayed green,
# because it only ever exercised sources/ and workspaces/.
SCM_RECLAIM_DIR_NAME="$(
  sed -n "s/^export const SCM_RECLAIM_DIR = '\(.*\)'$/\1/p" \
    "$REPO_ROOT/apps/api/src/lib/scm-storage.ts"
)"
[[ -n "$SCM_RECLAIM_DIR_NAME" ]] || {
  echo "could not read SCM_RECLAIM_DIR from apps/api/src/lib/scm-storage.ts" >&2
  exit 1
}

assert_container_writable() {
  local mount_spec="$1"
  docker run --rm \
    -e AUTH_SECRET=scm-storage-integration-secret \
    -e SCM_STORAGE_ROOT=/data/workspace \
    -v "$mount_spec:/data/workspace" \
    -e SCM_RECLAIM_DIR_NAME="$SCM_RECLAIM_DIR_NAME" \
    "$IMAGE_NAME" \
    sh -euc '
      touch /data/workspace/sources/write-check /data/workspace/workspaces/write-check
      rm /data/workspace/sources/write-check /data/workspace/workspaces/write-check
      # Mirrors isolateManagedScmStorage: park a directory inside the reclaim
      # root, then remove it.
      mkdir "/data/workspace/$SCM_RECLAIM_DIR_NAME/scm_probe-localPath"
      rmdir "/data/workspace/$SCM_RECLAIM_DIR_NAME/scm_probe-localPath"
    '
}

# Named volume: Docker creates a root-owned mount; the entrypoint must provision
# writable managed children without requiring an operator shell.
docker volume create "$VOLUME_NAME" >/dev/null
assert_container_writable "$VOLUME_NAME"

# Root-owned bind: common when Docker or an administrator creates the directory.
# The mount root must stay root-owned while appuser receives only its children.
ROOT_BIND="$INTEGRATION_ROOT/root-bind"
mkdir -p "$ROOT_BIND"
sudo chown 0:0 "$ROOT_BIND"
assert_container_writable "$ROOT_BIND"
[[ "$(stat -c '%u:%g' "$ROOT_BIND")" == "0:0" ]]
[[ "$(stat -c '%u:%g' "$ROOT_BIND/sources")" == "10001:10001" ]]
[[ "$(stat -c '%u:%g' "$ROOT_BIND/workspaces")" == "10001:10001" ]]
# The root stays root-owned by design, so appuser can only ever write here if
# the entrypoint pre-created and handed over this directory.
[[ "$(stat -c '%u:%g' "$ROOT_BIND/$SCM_RECLAIM_DIR_NAME")" == "10001:10001" ]]

# User-owned explicit bind: preserve the operator's mount-root identity too.
USER_BIND="$INTEGRATION_ROOT/user-bind"
mkdir -p "$USER_BIND"
USER_BIND_OWNER="$(stat -c '%u:%g' "$USER_BIND")"
assert_container_writable "$USER_BIND"
[[ "$(stat -c '%u:%g' "$USER_BIND")" == "$USER_BIND_OWNER" ]]

echo "SCM storage Docker ownership matrix passed"
