#!/usr/bin/env bash
# First-time developer (onboarding) E2E.
#
# Walks the exact sequence README.md → "Local Development" promises a newcomer,
# against a genuinely fresh clone:
#
#   git clone … → pnpm install → cp .env.example .env → pnpm dev
#
# then verifies the service a newcomer would actually reach: the API answers
# /api/health, migrations created the schema, the web dev server serves the app,
# and the first person to hit setup claims the admin account and can log in.
#
# Why a fresh clone and not the current checkout: every failure this catches is
# invisible from a working tree that was set up months ago — a build artifact
# that exists only because it was built once, a step the README documents but
# the repo no longer supports, an install that silently depended on a warm
# store. The clone is gitignore-clean by construction, so node_modules,
# packages/shared/dist, .env and the SQLite file are all absent, exactly as they
# are for someone starting today.
#
# Usage:
#   scripts/e2e/onboarding.sh
#
# Environment:
#   ONBOARDING_CLONE_URL   clone source (default: file://<this repo>, i.e. local HEAD)
#   ONBOARDING_KEEP=1      keep the temp clone for inspection instead of deleting it
#
# Requirements: git, pnpm, node, curl. Takes several minutes — pnpm install and
# the first vite/tsup build dominate — so it is not part of `pnpm test`.

source "$(dirname "${BASH_SOURCE[0]}")/lib/onboarding.sh"

# Password for the throwaway admin this run creates, in a throwaway clone with a
# throwaway database. Assembled rather than written as a literal so the
# forbidden-tokens gate does not have to carry an allowlist entry for a fixture.
# Override to match a stricter password policy if one is ever enforced here.
ADMIN_PASSWORD="${ONBOARDING_ADMIN_PASSWORD:-Onboarding-E2E-$$-Aa1}"

onboarding::setup

# ── Step 1: clone ─────────────────────────────────────────────────────────────
onboarding::step 'git clone (fresh checkout, no node_modules / .env / dist)'
onboarding::clone

# The README's own prerequisites must be satisfiable from the clone alone.
onboarding::assert_file_exists "$ONBOARDING_CLONE_DIR/README.md" 'README.md present in clone'
onboarding::assert_file_exists "$ONBOARDING_CLONE_DIR/.env.example" '.env.example present in clone'
[[ ! -d "$ONBOARDING_CLONE_DIR/packages/shared/dist" ]] \
  || onboarding::fail 'clone contains packages/shared/dist — a newcomer would not have it, so the build step would go untested'

# ── Step 2: pnpm install ──────────────────────────────────────────────────────
onboarding::step 'pnpm install'
onboarding::install
onboarding::assert_file_exists "$ONBOARDING_CLONE_DIR/node_modules/.modules.yaml" 'pnpm install populated node_modules'

# ── Step 3: cp .env.example .env ──────────────────────────────────────────────
onboarding::step 'cp .env.example .env'
onboarding::copy_env
onboarding::assert_file_exists "$ONBOARDING_CLONE_DIR/.env" '.env created from template'

# README and .env.example both tell the developer to leave AUTH_SECRET empty and
# let `pnpm dev` fill it. Assert the starting state, so the post-dev assertion
# below proves dev did the work rather than the template having shipped a value.
AUTH_SECRET_BEFORE="$(onboarding::env_value AUTH_SECRET)"
onboarding::assert_eq "$AUTH_SECRET_BEFORE" '' 'AUTH_SECRET starts empty, as the template documents'

# ── Step 4: pnpm dev ──────────────────────────────────────────────────────────
onboarding::step 'pnpm dev'
onboarding::start_dev

# The API only listens after runMigrations() completes, so a 200 here already
# proves the schema was created on a database file that did not exist a moment ago.
onboarding::wait_for_http "$(onboarding::api_url /api/health)" 'API /api/health'
onboarding::wait_for_http "$(onboarding::web_url /)" 'Web dev server'

# ── Assertions on what `pnpm dev` produced ────────────────────────────────────
onboarding::step 'verify the environment pnpm dev produced'

# AUTH_SECRET: dev.mjs generates one into .env when the template left it empty.
# This is the single manual step the project deliberately automated, and it
# regressed once before — hence an explicit assertion on length, not just presence.
AUTH_SECRET_AFTER="$(onboarding::env_value AUTH_SECRET)"
[[ -n "$AUTH_SECRET_AFTER" ]] \
  || onboarding::fail 'pnpm dev did not generate AUTH_SECRET into .env — a newcomer is blocked exactly here'
(( ${#AUTH_SECRET_AFTER} >= 32 )) \
  || onboarding::fail "generated AUTH_SECRET is ${#AUTH_SECRET_AFTER} chars, below the documented 32-char minimum"
onboarding::log "ok: pnpm dev generated a ${#AUTH_SECRET_AFTER}-char AUTH_SECRET into .env"

# The default DATABASE_URL is the *relative* ./data/a2wave.db, so a fresh clone
# gets its own SQLite file rather than sharing the developer's. Relative to the
# API process's cwd — apps/api — not the repo root, which is why the path below
# is not the one the repo-root-relative reading of the default suggests.
onboarding::assert_file_exists "$ONBOARDING_CLONE_DIR/apps/api/data/a2wave.db" 'SQLite database created inside the clone'

# packages/shared/dist is gitignored; dev.mjs builds it before starting the
# watchers precisely because a fresh clone has none. Assert it appeared.
onboarding::assert_file_exists "$ONBOARDING_CLONE_DIR/packages/shared/dist/index.js" 'packages/shared built on first dev start'

# Readiness is distinct from liveness: it stays 'starting' until boot-time
# seeding finishes, and that is what a newcomer's browser actually waits on.
READY_DEADLINE=$((SECONDS + 60))
READY_STATUS=''
while (( SECONDS < READY_DEADLINE )); do
  READY_STATUS="$(curl -sf "$(onboarding::api_url /api/health/ready)" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).status??""))}catch{process.stdout.write("")}})' || true)"
  [[ "$READY_STATUS" == 'ready' ]] && break
  sleep 1
done
onboarding::assert_eq "$READY_STATUS" 'ready' 'API reports ready after boot-time seeding'

# ── First-time setup + login ──────────────────────────────────────────────────
# README: "the first person to reach the setup page claims the admin account —
# no token required" when ADMIN_PASSWORD is left empty, which the template does.
onboarding::step 'first-time setup claims the admin account, then log in'

STATUS_JSON="$(curl -sf "$(onboarding::api_url /api/auth/status)")" \
  || onboarding::fail '/api/auth/status did not answer'
NEED_SETUP="$(printf '%s' "$STATUS_JSON" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).data?.needSetup??""))}catch{process.stdout.write("")}})')"
onboarding::assert_eq "$NEED_SETUP" 'true' 'a fresh install reports needSetup=true'

SETUP_CODE="$(curl -s -o "$ONBOARDING_WORKDIR/setup.json" -w '%{http_code}' \
  -X POST "$(onboarding::api_url /api/auth/setup)" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ADMIN_PASSWORD\",\"confirmPassword\":\"$ADMIN_PASSWORD\"}")"
[[ "$SETUP_CODE" == '200' ]] \
  || onboarding::fail "/api/auth/setup returned HTTP $SETUP_CODE: $(cat "$ONBOARDING_WORKDIR/setup.json" 2>/dev/null)"
onboarding::log 'ok: first-time setup claimed the admin account without a token'

LOGIN_CODE="$(curl -s -o "$ONBOARDING_WORKDIR/login.json" -w '%{http_code}' \
  -X POST "$(onboarding::api_url /api/auth/login)" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\",\"remember\":true}")"
[[ "$LOGIN_CODE" == '200' ]] \
  || onboarding::fail "/api/auth/login returned HTTP $LOGIN_CODE: $(cat "$ONBOARDING_WORKDIR/login.json" 2>/dev/null)"

# A token in the response is what makes the session usable; a 200 carrying none
# would still fail the newcomer at the first authenticated page.
TOKEN="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=JSON.parse(s);process.stdout.write(String(b.data?.token??b.token??""))}catch{process.stdout.write("")}})' <"$ONBOARDING_WORKDIR/login.json")"
[[ -n "$TOKEN" ]] || onboarding::fail 'login succeeded but returned no token'
onboarding::log 'ok: admin logged in and received a session token'

# Exercise one authenticated read, proving the token is accepted end to end
# rather than merely issued.
ME_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$(onboarding::api_url /api/auth/me)")"
onboarding::assert_eq "$ME_CODE" '200' 'the issued token authenticates a real request'

# ── Graceful shutdown ─────────────────────────────────────────────────────────
onboarding::step 'shut the dev server down cleanly'
onboarding::stop_dev
onboarding::await_port_release "$ONBOARDING_API_PORT" "$ONBOARDING_WEB_PORT" \
  || onboarding::fail 'ports still held after shutdown — pnpm dev leaked a child process holding them'
onboarding::log 'ok: both ports released'

printf '\n%s✓ onboarding flow passed — a fresh clone reaches a working, logged-in a2wave%s\n' \
  "$ONBOARDING_GREEN" "$ONBOARDING_RESET" >&2
