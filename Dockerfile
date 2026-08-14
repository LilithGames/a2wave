# --- Stage 1: Build ---
# Must match the production stage's base (Debian/glibc) and Node major. The stages
# only exchange compiled JS today, but a musl builder feeding a glibc runtime is one
# `COPY --from=builder node_modules` away from shipping .node binaries built against
# the wrong libc/ABI — a failure that appears only at runtime, never at build time.
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
# python3/make/g++: fallback toolchain for node-gyp to compile native modules (e.g. better-sqlite3).
# Some platform/libc combos have no prebuilt binary, so the install step falls back to local
# compilation and the build fails outright without the toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --shamefully-hoist

COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/
COPY apps/web/ apps/web/

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

RUN cd packages/shared && ../../node_modules/.bin/tsup src/index.ts --format esm --dts && \
    cd /app && pnpm --filter @a2wave/api build && \
    cd /app/apps/web && /app/node_modules/.bin/tsc -b && /app/node_modules/.bin/vite build

# --- Stage 2: Production ---
# Use Debian slim (glibc) so the glibc-compiled p4 binary runs natively
FROM node:22-slim AS production

# Redeclared because ARGs do not cross stage boundaries; the release workflow passes the
# tag via --build-arg APP_VERSION, and a plain `docker build` falls back to "dev" rather
# than to a hardcoded number that silently rots (it read 0.1.0 while the project was 0.7.0).
ARG APP_VERSION=dev
# The runtime needs it too, not just the LABEL: routes/health.ts resolves the version from
# process.env.APP_VERSION and falls back to `git describe`, which cannot work in an image
# where /app is not a git repository — so without this every released image reports "dev".
ENV APP_VERSION=$APP_VERSION

LABEL org.opencontainers.image.title="a2wave" \
      org.opencontainers.image.description="Natural-language-driven Agent orchestration platform" \
      org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.source="https://github.com/LilithGames/a2wave"

# Only the shims here: `corepack prepare` (which caches a ~20MB pnpm tarball under
# /root/.cache) runs inside the production-install RUN below, where the cache is
# deleted in the same layer. pnpm exists for that one build step — nothing at
# runtime spawns it (the provider-CLI installer uses npm), so caching it in its
# own layer shipped 20MB the service never reads.
RUN corepack enable

ARG TARGETARCH

# git: SCM operations; p4: Perforce CLI (glibc binary, requires Debian/glibc base)
# bubblewrap: Claude Code native sandbox on Linux; ripgrep: fast repository search
# gosu: drop privileges from root to appuser in docker-entrypoint.sh (UID remap pattern, see docker-entrypoint.sh)
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates sqlite3 procps tini bubblewrap ripgrep socat gosu && rm -rf /var/lib/apt/lists/* && \
    case "${TARGETARCH}" in \
      amd64) P4_ARCH="x86_64"; P4_SHA256="5132fc1fc81c1911700924f18375558eec30d0aa7c82e80f8397da0b9f352a86" ;; \
      arm64) P4_ARCH="aarch64"; P4_SHA256="a3813fc18cca541d347f38874d8c835b370d11478d6430a07a23eeb17268bb9f" ;; \
      *)     P4_ARCH="x86_64"; P4_SHA256="5132fc1fc81c1911700924f18375558eec30d0aa7c82e80f8397da0b9f352a86" ;; \
    esac && \
    curl -fsSL "https://cdist2.perforce.com/perforce/r24.2/bin.linux26${P4_ARCH}/p4" \
      -o /usr/local/bin/p4 && \
    # Verify the binary against Perforce's published SHA256SUMS so a poisoned CDN
    # or MITM (esp. builds routed through a proxy) cannot slip in a backdoored p4.
    # Explicit compare (not `sha256sum -c`) so any mismatch is an unambiguous
    # non-zero exit that fails the build.
    ACTUAL_SHA256="$(sha256sum /usr/local/bin/p4 | cut -d' ' -f1)" && \
    if [ "${ACTUAL_SHA256}" != "${P4_SHA256}" ]; then \
      echo "p4 checksum mismatch: expected ${P4_SHA256}, got ${ACTUAL_SHA256}" >&2; exit 1; \
    fi && \
    chmod +x /usr/local/bin/p4

# Install uv (provides uvx for Python-based MCP servers).
# Pin an exact version via the versioned installer URL rather than piping the
# floating `https://astral.sh/uv/install.sh` to a shell — the floating script can
# change under us between builds, breaking reproducibility and widening the
# supply-chain surface. Bump UV_VERSION deliberately when upgrading.
ARG UV_VERSION=0.11.32
# The installer's own copies under /root/.local are deleted in the same layer:
# uv alone is ~55MB, so leaving them would ship every binary in this layer twice.
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh && \
    cp /root/.local/bin/uv /usr/local/bin/uv && \
    cp /root/.local/bin/uvx /usr/local/bin/uvx && \
    chmod 755 /usr/local/bin/uv /usr/local/bin/uvx && \
    rm -rf /root/.local && \
    uv --version

# Runtime installs land in the service HOME, which docker-compose persists as a
# named volume: the service runs as non-root appuser and cannot write
# /usr/local/bin or /opt, and keeping the CLIs in a volume means upgrading the
# image does not force a reinstall.
#
# The install directories are deliberately NOT added to the image-global PATH.
# They are writable by the service user, and several root processes resolve bare
# command names against the global PATH *outside* docker-entrypoint.sh, where no
# in-script hardening can reach them:
#   - ENTRYPOINT `tini` — resolved by the container runtime before the script runs
#   - HEALTHCHECK `curl` — a separate root process every 30s that never sees the
#     script's local PATH edits
# Both were reproduced executing a planted binary at euid=0. Those two are now
# invoked by absolute path (see the end of this file), and the CLI directories are
# put on PATH only for the unprivileged service process, by docker-entrypoint.sh
# at the moment it drops privileges.
ENV A2WAVE_CLI_INSTALL_ROOT=/home/appuser/.a2wave
# No NPM_CONFIG_PREFIX here on purpose: npm-installed CLIs each get their own
# prefix under <root>/npm/<kind> (so promoting one cannot delete another), and
# the installer passes that per-kind prefix explicitly on every call. A single
# image-wide prefix would be the shared directory that made promotion unsafe.
# Required: the image flattens the installer to /app/provider-clis, whereas a
# source checkout keeps it at scripts/provider-clis. Without this the service
# would look for the lock at the checkout-relative path and find nothing.
ENV A2WAVE_CLI_LOCK_DIR=/app/provider-clis

WORKDIR /app

# Created before the app files land so every COPY below can set ownership inline.
# A trailing `chown -R /app` would instead duplicate the whole tree into a new
# layer (~220MB) purely to rewrite its metadata. /app/data is created here for
# the same reason: bundled with user creation, it costs no extra layer.
RUN groupadd -r -g 10001 appuser && useradd -r -u 10001 -m -g appuser appuser && \
    chown appuser:appuser /app && \
    mkdir -p /app/data/skills && chown -R appuser:appuser /app/data

# Only the install inputs — CHANGELOG.md ships with the LICENSE group further
# down, because it changes on every release and anything COPY'd here invalidates
# the expensive production-install layer below.
COPY --chown=appuser:appuser pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY --chown=appuser:appuser packages/shared/package.json packages/shared/
COPY --chown=appuser:appuser apps/api/package.json apps/api/

# python3/make/g++ as a fallback to compile native modules like better-sqlite3 (some arch/libc combos
# have no prebuilt binary; see the same comment in the builder stage); purge them together with the apt
# cache right after install so they are not left in the final image.
# pnpm runs as root here, so its output is chowned explicitly. Scoped to the
# node_modules trees it creates -- the store at the root plus the per-workspace
# symlink dirs -- rather than all of /app, whose other paths already land owned
# by appuser via COPY --chown.
#
# Discovered with find rather than listed by hand: `--prod` only materialises a
# workspace's node_modules when it actually has production dependencies, so a
# hardcoded path list would break the build the day one of them becomes
# type-only. -prune stops the descent at each match (the -R does that work).
# The trailing cleanup removes what only the install step needed: the pnpm store
# (its files are hardlinked into node_modules, so deleting the store keeps every
# module intact while dropping the store's own metadata from the layer), the
# corepack cache holding the pnpm tarball `corepack prepare` fetched, and npm's
# cache. Together they are ~60MB that the runtime never reads.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    corepack prepare pnpm@9.15.4 --activate && \
    pnpm install --frozen-lockfile --prod && \
    apt-get purge -y --auto-remove python3 make g++ && \
    rm -rf /var/lib/apt/lists/* /root/.local/share/pnpm /root/.cache /root/.npm && \
    find /app -maxdepth 3 -name node_modules -prune -exec chown -R appuser:appuser {} +

# Provider CLIs are NOT baked into the image. The growing roster adds well over
# 1GB plus CodeGraph, while a given deployment typically uses one or two — so
# preinstalling scales the image linearly
# against a need that stays flat. Ship the lock plus its installer instead and
# let an admin install on demand from the UI (POST /api/provider-clis/:kind/install),
# which reuses this exact installer and therefore the same pinned versions and
# checksum verification the build used to perform.
# Positioned after the production install on purpose: the lock's pins move on
# their own review cadence, and a bump must not invalidate the node_modules layer.
# Kept as one COPY per source rather than a single multi-source form: the
# provider-CLI contract test asserts each path individually, and collapsing them
# saved only two near-empty metadata layers while breaking that check.
COPY provider-cli-lock.json /app/provider-clis/provider-cli-lock.json
COPY scripts/provider-clis/install.mjs /app/provider-clis/install.mjs
COPY scripts/provider-clis/provider-cli-lock.schema.json /app/provider-clis/provider-cli-lock.schema.json

COPY --chown=appuser:appuser LICENSE NOTICE README.md CHANGELOG.md ./
# The OFL requires the font's license to travel with the font binaries, which the web
# bundle below embeds — see NOTICE.
COPY --chown=appuser:appuser licenses ./licenses

COPY --from=builder --chown=appuser:appuser /app/packages/shared/dist packages/shared/dist
COPY --from=builder --chown=appuser:appuser /app/apps/api/dist apps/api/dist
COPY --from=builder --chown=appuser:appuser /app/apps/api/src/builtin-skills apps/api/dist/builtin-skills
COPY --from=builder --chown=appuser:appuser /app/apps/api/drizzle apps/api/drizzle
# Both migration lineages ship: the runtime picks one from the DATABASE_URL
# scheme, so a PostgreSQL deployment finds no migrations at all without this and
# every query fails with "relation does not exist" after a clean boot.
COPY --from=builder --chown=appuser:appuser /app/apps/api/drizzle-pg apps/api/drizzle-pg
COPY --from=builder --chown=appuser:appuser /app/apps/web/dist apps/web/dist

# Note: `USER appuser` is deliberately omitted. docker-entrypoint.sh starts as root to adapt the
# UID (aligning appuser with the owner UID of host-mounted directories such as .claude), then
# execs gosu to drop to appuser for the main process. The service still runs as non-root at
# runtime, which is equivalent in security to `USER appuser`.

ENV NODE_ENV=production
ENV PORT=3502
ENV DATABASE_URL=/app/data/a2wave.db
ENV HOME=/home/appuser
ENV USER=appuser
ENV LOGNAME=appuser

# --chmod instead of a trailing `RUN chmod +x`, which would re-store both scripts
# in an extra layer purely to flip the executable bit.
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=0755 scripts/ensure-container-auth-secret.sh /usr/local/bin/ensure-container-auth-secret.sh

EXPOSE 3502

STOPSIGNAL SIGTERM

# Readiness, not liveness: anything that waits for `healthy` before calling a rollout
# successful — an orchestrator's readinessProbe, a deploy script, `compose up --wait` —
# needs that to mean "boot-time seeding finished", not merely "the port is open".
# /api/health/ready answers 503 until then.
# Absolute paths on purpose: this is a separate root process that does not inherit
# docker-entrypoint.sh's hardened PATH, so a bare `curl` would resolve through the
# image-global PATH every 30 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD /usr/bin/curl -f http://localhost:3502/api/health/ready || exit 1

# Absolute path on purpose: the container runtime resolves this as root before
# docker-entrypoint.sh gets to run, so a bare `tini` is resolved against the
# image-global PATH with no opportunity for in-script hardening.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
