#!/usr/bin/env bash
# Shared helpers for restart-recovery E2E scripts.
#
# Every scenario is expected to:
#   1. source this file
#   2. call `e2e::setup` (creates sandbox DB, sets env, runs migrations, seeds agent)
#   3. call `e2e::start_api` / `e2e::stop_api` / `e2e::kill_api` as needed
#   4. use `e2e::sql` and `e2e::assert_eq` to verify DB state
#   5. call `e2e::cleanup` on exit (registered automatically via trap)

set -euo pipefail

# --- Paths ---
E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"     # scripts/e2e
REPO_ROOT="$(cd "$E2E_ROOT/../.." && pwd)"                      # repo root

# --- Colors for readability ---
if [[ -t 1 ]]; then
  E2E_COLOR_GREEN=$'\e[32m'
  E2E_COLOR_RED=$'\e[31m'
  E2E_COLOR_YELLOW=$'\e[33m'
  E2E_COLOR_RESET=$'\e[0m'
else
  E2E_COLOR_GREEN=''
  E2E_COLOR_RED=''
  E2E_COLOR_YELLOW=''
  E2E_COLOR_RESET=''
fi

e2e::log() { printf '%s[e2e]%s %s\n' "$E2E_COLOR_GREEN" "$E2E_COLOR_RESET" "$*" >&2; }
e2e::warn() { printf '%s[e2e warn]%s %s\n' "$E2E_COLOR_YELLOW" "$E2E_COLOR_RESET" "$*" >&2; }
e2e::fail() {
  printf '%s[e2e FAIL]%s %s\n' "$E2E_COLOR_RED" "$E2E_COLOR_RESET" "$*" >&2
  if [[ -n "${E2E_LOG_FILE:-}" && -f "$E2E_LOG_FILE" ]]; then
    printf '%s--- api.log tail (60 lines) ---%s\n' "$E2E_COLOR_YELLOW" "$E2E_COLOR_RESET" >&2
    tail -60 "$E2E_LOG_FILE" >&2 || true
  fi
  exit 1
}

# --- State shared between setup / teardown ---
E2E_DB_PATH=""
E2E_LOG_FILE=""
E2E_API_PID=""
E2E_PORT=""
E2E_AGENT_ID="agt_e2e_hardening"

e2e::setup() {
  # Kill any stragglers from a previous aborted run that may still be holding
  # the sandbox port. Otherwise the fresh API will hit EADDRINUSE.
  if command -v lsof >/dev/null 2>&1; then
    local stragglers
    stragglers="$(lsof -ti ":${E2E_PORT_OVERRIDE:-31099}" 2>/dev/null || true)"
    if [[ -n "$stragglers" ]]; then
      e2e::warn "killing straggler processes on port ${E2E_PORT_OVERRIDE:-31099}: $stragglers"
      echo "$stragglers" | xargs -I {} kill -9 {} 2>/dev/null || true
      sleep 0.5
    fi
  fi

  local tmpdir
  tmpdir="$(mktemp -d -t a2wave-e2e-XXXXXX)"
  export E2E_DB_PATH="$tmpdir/a2wave.db"
  export E2E_LOG_FILE="$tmpdir/api.log"
  export E2E_PORT="${E2E_PORT_OVERRIDE:-31099}"

  # Tell the API to use this sandbox DB + port.
  export DATABASE_URL="$E2E_DB_PATH"
  export PORT="$E2E_PORT"
  export NODE_ENV="test"
  # Deterministic 32-char secret so the env validator in production-mode
  # checks still pass if some subprocess resets NODE_ENV.
  export AUTH_SECRET="${AUTH_SECRET:-e2e-hardening-auth-secret-xxxxxxx}"

  e2e::log "sandbox db: $E2E_DB_PATH"
  e2e::log "sandbox log: $E2E_LOG_FILE"

  # Run migrations against the empty sandbox.
  ( cd "$REPO_ROOT/apps/api" && NODE_ENV=test AUTH_SECRET="$AUTH_SECRET" DATABASE_URL="$DATABASE_URL" pnpm db:migrate ) >/dev/null

  # Seed a minimal agent row — we don't need any real engine config because
  # the restart-recovery scenarios never actually execute runs; they only
  # verify that recoverOnStartup transitions persisted rows correctly.
  e2e::sql "
    INSERT INTO users (id, username, role, is_active, created_at, updated_at)
      VALUES ('usr_e2e', 'e2e-fixture', 'admin', 1, unixepoch(), unixepoch())
      ON CONFLICT(id) DO NOTHING;
    INSERT INTO agents (
      id, name, description, type, config, status, icon,
      skills, mcp_server_ids, kb_document_ids,
      max_concurrency, publish_status, user_id,
      created_at, updated_at
    ) VALUES (
      '$E2E_AGENT_ID', 'E2E Hardening', 'restart recovery fixture', 'cursor', '{}', 'active', '🧪',
      '[]', '[]', '[]',
      1, 'published', 'usr_e2e',
      unixepoch(), unixepoch()
    );
  "

  trap 'e2e::cleanup' EXIT INT TERM
}

e2e::cleanup() {
  # Best-effort — do not leak processes on test failure.
  if [[ -n "$E2E_API_PID" ]] && kill -0 "$E2E_API_PID" 2>/dev/null; then
    kill -9 "$E2E_API_PID" 2>/dev/null || true
  fi
  if [[ -n "$E2E_DB_PATH" && -f "$E2E_DB_PATH" ]]; then
    rm -f "$E2E_DB_PATH" "$E2E_DB_PATH-shm" "$E2E_DB_PATH-wal"
  fi
}

e2e::sql() {
  sqlite3 "$E2E_DB_PATH" "$1"
}

e2e::assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    e2e::fail "$label: expected '$expected', got '$actual'"
  fi
  e2e::log "ok: $label"
}

e2e::assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    e2e::fail "$label: '$haystack' does not contain '$needle'"
  fi
  e2e::log "ok: $label"
}

# Start API, redirecting combined output to E2E_LOG_FILE.
# Waits until /api/health returns 200 AND the recoverOnStartup + Feishu
# replay pipelines have both completed (both log a well-known line). This
# prevents tests from racing the async boot sequence.
e2e::start_api() {
  ( cd "$REPO_ROOT/apps/api" && pnpm exec tsx src/index.ts ) \
    >"$E2E_LOG_FILE" 2>&1 &
  E2E_API_PID=$!
  e2e::log "api started pid=$E2E_API_PID port=$E2E_PORT"

  local deadline=$((SECONDS + 30))
  local healthy=0
  while (( SECONDS < deadline )); do
    if (( healthy == 0 )) && curl -sf "http://localhost:$E2E_PORT/api/health" >/dev/null 2>&1; then
      healthy=1
      e2e::log "api is healthy (waiting for recovery to complete)"
    fi
    if (( healthy == 1 )) \
       && e2e::log_contains 'Startup task recovery completed' \
       && e2e::log_contains 'Feishu pending message replay completed'; then
      e2e::log "api boot pipeline completed"
      return 0
    fi
    if ! kill -0 "$E2E_API_PID" 2>/dev/null; then
      e2e::warn "api died during startup — last 40 log lines:"
      tail -40 "$E2E_LOG_FILE" >&2 || true
      e2e::fail "api exited before becoming healthy"
    fi
    sleep 0.3
  done

  e2e::fail "api did not finish boot pipeline within 30s"
}

# Graceful stop (SIGTERM then wait). Use for clean shutdowns.
e2e::stop_api() {
  [[ -z "$E2E_API_PID" ]] && return 0
  kill -TERM "$E2E_API_PID" 2>/dev/null || true
  wait "$E2E_API_PID" 2>/dev/null || true
  E2E_API_PID=""
}

# Forceful kill (SIGKILL). Use to simulate a crash.
e2e::kill_api() {
  [[ -z "$E2E_API_PID" ]] && return 0
  kill -9 "$E2E_API_PID" 2>/dev/null || true
  wait "$E2E_API_PID" 2>/dev/null || true
  E2E_API_PID=""
}

# Grep the API log for a substring. Returns 0 if found.
e2e::log_contains() {
  grep -F -- "$1" "$E2E_LOG_FILE" >/dev/null 2>&1
}

# Extract a numeric JSON field from the log, tolerating both compact and
# pino-pretty multi-line formats. Strips ANSI color codes first because
# pino-pretty wraps keys like `\e[35mkey\e[39m: value`.
e2e::log_json_field() {
  local pattern="$1" key="$2"
  # shellcheck disable=SC2016  # intentional literal awk pattern
  awk -v pat="$pattern" -v key="$key" '
    { gsub(/\033\[[0-9;]*m/, "") }
    index($0, pat) > 0 { in_block = 20; next }
    in_block > 0 {
      if (match($0, "\"?" key "\"?[[:space:]]*:[[:space:]]*[0-9]+")) {
        line = substr($0, RSTART, RLENGTH)
        n = split(line, parts, ":")
        gsub(/[^0-9]/, "", parts[n])
        print parts[n]
        exit
      }
      in_block--
    }
  ' "$E2E_LOG_FILE"
}
