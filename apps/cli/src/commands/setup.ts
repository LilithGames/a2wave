import { execSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defineCommand } from 'citty'
import { loadConfig, saveConfig } from '../config.js'
import { CliError } from '../errors.js'
import { assertKnownOptions } from '../lib/args.js'
import { submitInitialAdminPassword } from '../lib/initial-admin.js'
import { readSecret } from '../lib/prompt.js'
import {
  buildComposeFile,
  buildEnvFile,
  DEFAULT_PORT,
  generateAuthSecret,
  generatePostgresPassword,
  generateProjectName,
  migrateComposeImageToVariable,
  readEnvDatabaseUrl,
  readEnvImage,
  replaceEnvImage,
  validateDatabaseUrl,
  validateImageRef,
} from '../lib/setup-plan.js'
import { getVersion } from '../version.js'

/**
 * Image installed when `--image` is omitted.
 *
 * Pinned to this CLI's own version, not `latest`: the platform and the CLI
 * share one version line, so `a2wave@X.Y.Z` must install the X.Y.Z platform
 * rather than whatever `latest` happens to point at.
 *
 * The tag carries no leading `v` — docker.yml strips it from the git tag, so
 * the published image for v0.7.1 is `:0.7.1`.
 */
export const DEFAULT_IMAGE = `ghcr.io/lilithgames/a2wave:${getVersion()}`

const HEALTH_TIMEOUT_SECONDS = 90
const HEALTH_POLL_INTERVAL_MS = 2000
// Per-request cap for the health/readiness probes. Without it a container that
// accepts the connection and then never sends response headers holds `await
// fetch()` open forever — the poll deadline is only consulted between attempts,
// so --health-timeout would never fire and the rollback would never run.
const PROBE_TIMEOUT_MS = 5000

/**
 * Per-request timeout for one probe, never longer than the remaining budget.
 * Clamped to a floor so a zero/short --health-timeout still issues one real
 * attempt rather than aborting instantly.
 */
function probeTimeoutMs(deadline: number): number {
  return Math.max(50, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()))
}

/**
 * Single-quote a value for /bin/sh.
 *
 * execSync runs its command through a shell, so an install path containing a
 * space would word-split: `-f /tmp/My Installs/x.yml` hands compose only
 * `/tmp/My`, every call fails, and the pull try/catch misreports it as a
 * missing image. Embedded single quotes are closed, escaped and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Environment for a compose child, with the two keys the generated compose file
 * interpolates decided here rather than inherited.
 *
 * Compose prefers the process environment over the install `.env`, so an
 * exported `A2WAVE_IMAGE` / `A2WAVE_PORT` in the operator's shell would decide
 * which image starts and on which port — while this command wrote something
 * else into `.env` and then reported success. `null` means "let compose resolve
 * it from the file", which requires DELETING the key, not leaving it inherited.
 */
function composeChildEnv(image: string | null, port: number | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // `delete` is required, not stylistic: assigning undefined makes Node pass
  // the literal string "undefined" to the child.
  // biome-ignore lint/performance/noDelete: the key must be absent, not ""
  if (image === null) delete env.A2WAVE_IMAGE
  else env.A2WAVE_IMAGE = image
  // biome-ignore lint/performance/noDelete: same — see above
  if (port === null) delete env.A2WAVE_PORT
  else env.A2WAVE_PORT = String(port)
  // Always deleted, never set: the install .env is the sole source of truth
  // for the database keys in every path (fresh install writes them before the
  // first compose call; an upgrade never rewrites them). DATABASE_URL is the
  // likeliest inherited key of them all — every dev machine running this repo
  // exports or .env-scopes one — and Compose would prefer it over the file.
  // biome-ignore lint/performance/noDelete: same — see above
  delete env.DATABASE_URL
  // biome-ignore lint/performance/noDelete: same — see above
  delete env.POSTGRES_PASSWORD
  // Like DATABASE_URL, these are operator-owned install settings. An exported
  // shell value must not override the generated install's .env file.
  // biome-ignore lint/performance/noDelete: same — see above
  delete env.SCM_STORAGE_ROOT
  // biome-ignore lint/performance/noDelete: same — see above
  delete env.SCM_WORKSPACES_ALLOWED_ROOTS
  return env
}

/**
 * A `docker compose` invocation pinned to one install.
 *
 * `-p` alone is not enough: `COMPOSE_FILE` in the caller's environment beats
 * cwd, so compose would read a different stack than the file this command
 * edits — recreating the wrong services, mounting another project's volume,
 * and then health-checking that instead. `-f` pins the file the same way `-p`
 * pins the project.
 */
function composeCmd(dir: string, projectName: string, subcommand: string): string {
  return `docker compose -p ${projectName} -f ${shellQuote(join(dir, 'docker-compose.yml'))} ${subcommand}`
}

/**
 * One install, plus the values every compose call against it must pin.
 *
 * `dir` + `projectName` were previously threaded as a bare pair through five
 * functions, which is why the pins kept being forgotten: the probes had no
 * parameter to carry them in. Bundling them means a caller cannot pass the
 * install without also passing what to pin — `image`/`port` are `null` for
 * "delete the key and let the compose file's own default win", never absent.
 */
type Install = {
  dir: string
  projectName: string
  image: string | null
  port: number | null
}

/**
 * The ONLY way this file runs `docker compose`.
 *
 * Every project-scoped call must decide `A2WAVE_IMAGE` / `A2WAVE_PORT` rather
 * than inherit them, and repeated review found that spelling `env:` at each
 * call site does not hold: five separate sites accumulated, four of them
 * read-only probes nobody thought of as "running compose".
 *
 * How much an inherited value costs depends on the subcommand, and that is
 * exactly why this is centralised rather than judged per call site. Measured on
 * Compose v5.1.0: `config` and `up` reject an invalid `A2WAVE_PORT` outright
 * (`invalid hostPort`), while `ps` / `logs` / `stop` tolerate it and succeed.
 * An exported `A2WAVE_IMAGE`, by contrast, is honoured everywhere — `config`
 * resolves the service to whatever the shell exported.
 *
 * So the danger is not one reproducible failure but the version- and
 * subcommand-dependence itself: which probes degrade silently is a property of
 * the Compose build on the operator's machine, not of this code. Every call
 * deciding both keys makes that irrelevant, and folding the exec in here makes
 * it structural — a new call site cannot forget what it never has to write.
 */
function composeExec(
  install: Install,
  subcommand: string,
  options: { stdio: 'pipe' | 'inherit'; image?: string | null },
): string {
  const out = execSync(composeCmd(install.dir, install.projectName, subcommand), {
    cwd: install.dir,
    stdio: options.stdio,
    encoding: 'utf-8',
    // `image` overrides the install's own ref for one call — the rollback pins
    // the image it is restoring TO, which is not the one recorded in .env.
    env: composeChildEnv(options.image === undefined ? install.image : options.image, install.port),
  })
  // With stdio 'inherit' execSync resolves to null, not a string.
  return out ?? ''
}

function checkDockerAvailable(): void {
  try {
    execSync('docker --version', { stdio: 'pipe' })
  } catch {
    throw new CliError(
      'Docker is required but was not found. Install Docker first: https://docs.docker.com/get-docker/',
    )
  }
  try {
    execSync('docker compose version', { stdio: 'pipe' })
  } catch {
    throw new CliError(
      [
        'Docker Compose v2 was not found (podman-compose is not supported yet).',
        'It ships with Docker Desktop; on Linux install the docker-compose-plugin package.',
      ].join('\n'),
    )
  }
}

/** Bind-probe the port so a conflict surfaces before any file is written. */
function checkPortFree(port: number): Promise<void> {
  return new Promise((res, reject) => {
    const server = createServer()
    server
      .once('error', (err: NodeJS.ErrnoException) => {
        // Distinguish "someone is on this port" from "you may not bind it"
        const message =
          err.code === 'EACCES'
            ? `Permission denied binding port ${port} (ports below 1024 need elevated privileges). Pick a port ≥ 1024 with --port.`
            : err.code === 'EADDRINUSE'
              ? `Port ${port} is already in use. Pick another with --port, or stop the process occupying it.`
              : `Cannot bind port ${port}: ${err.code ?? err.message}`
        reject(new CliError(message))
      })
      .once('listening', () => {
        server.close(() => res())
      })
      .listen(port)
  })
}

async function promptWithDefault(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim()
    return answer || fallback
  } finally {
    rl.close()
  }
}

const CONFIRM_ATTEMPTS = 3

/**
 * Destructive-action gate (GitHub repo-deletion style): the user must type the
 * exact expected phrase — a lazy "y" is never accepted. Returns false after
 * CONFIRM_ATTEMPTS mismatches.
 */
async function confirmByTyping(banner: string, expectedPhrase: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(banner)
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      const answer = (await rl.question(`Type "${expectedPhrase}" to confirm: `)).trim()
      if (answer === expectedPhrase) return true
    }
    return false
  } finally {
    rl.close()
  }
}

/**
 * Mirrors the server's validatePassword (apps/api/src/lib/auth.ts). Checked
 * client-side purely to re-prompt on a typo instead of burning the one-shot
 * POST; the server remains the authority and re-validates every submission.
 */
function passwordPolicyError(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter.'
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter.'
  if (!/\d/.test(password)) return 'Password must contain a digit.'
  return null
}

const PASSWORD_ATTEMPTS = 3
/**
 * Prompt for the admin password (twice) and hand it straight to the freshly
 * started instance. Deliberately never returned to the caller, written to a
 * file, or passed through argv/env: the value exists only in this frame and
 * the request body. There is no --admin-password flag for the same reason —
 * argv is visible in `ps` and lands in shell history.
 *
 * Best-effort by design: the platform is already up and healthy by the time
 * this runs, so a failure here degrades to the manual web-setup hint rather
 * than failing an otherwise successful install.
 */
async function promptAndSetAdminPassword(localUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < PASSWORD_ATTEMPTS; attempt++) {
    const password = await readSecret('Admin password: ')
    // Empty input is the documented opt-out, not a validation failure: the web
    // setup screen is still there and this must never become a forced gate.
    if (password === '') {
      console.log('Skipped — set the password on first visit to the web UI.')
      return false
    }
    const confirmation = await readSecret('Confirm password: ')
    if (password !== confirmation) {
      console.log('Passwords do not match — try again.')
      continue
    }
    const policyError = passwordPolicyError(password)
    if (policyError) {
      console.log(policyError)
      continue
    }
    try {
      const res = await submitInitialAdminPassword(localUrl, password, confirmation)
      if (res.ok) return true
      // Report only the status and the server's error code, never the raw body:
      // echoing an arbitrary response into the terminal is how a future server
      // change could reflect the submitted password back into scrollback.
      const code = await res
        .json()
        .then((body) => (body as { error?: unknown }).error)
        .catch(() => undefined)
      const suffix = typeof code === 'string' ? `: ${code}` : ''
      console.log(`Could not set the admin password (HTTP ${res.status}${suffix}).`)
    } catch (err) {
      console.log(`Could not reach the platform to set the password: ${(err as Error).message}`)
    }
    return false
  }
  console.log('Admin password not set after 3 attempts.')
  return false
}

function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid port: ${raw}`)
  }
  return port
}

function parseHealthTimeout(raw: string): number {
  const seconds = Number(raw)
  // NaN would make the poll deadline never trip — the wait would spin forever
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new CliError(
      `Invalid --health-timeout: ${raw} (expected a non-negative number of seconds)`,
    )
  }
  return seconds
}

function parseBaseUrl(raw: string): string {
  // The value is written into CORS_ORIGIN, and a browser Origin is scheme +
  // host [+ port] only — a path, query, hash, or credentials would make every
  // cross-origin check fail. Require a pure origin.
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new CliError(`Invalid --base-url: ${raw} (expected an origin like http(s)://host[:port])`)
  }
  const isPureOrigin =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  if (!isPureOrigin) {
    throw new CliError(
      `Invalid --base-url: ${raw} — must be a pure origin (no path/query/hash/credentials), e.g. https://a2wave.example.com`,
    )
  }
  return url.origin
}

/**
 * Read the trusted per-install project name persisted in the dir's .env.
 * Compose precedence is shell env > .env, so a COMPOSE_PROJECT_NAME preset in
 * the caller's environment (CI, dotfiles) would silently override the .env
 * value — every compose invocation must therefore pass the name explicitly
 * via -p, which beats both. Returns null when no trusted name is available;
 * callers decide how to degrade (destructive paths must fail closed).
 */
function readProjectName(dir: string): string | null {
  try {
    const env = readFileSync(join(dir, '.env'), 'utf-8')
    const match = env.match(/^COMPOSE_PROJECT_NAME=([A-Za-z0-9_-]+)$/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Read the host port this install was created with (A2WAVE_PORT in its .env).
 * The upgrade path health-probes that port rather than the CLI default, which
 * would otherwise report a false failure for any install on a custom port.
 *
 * Returns null only when the key is genuinely absent (a hand-trimmed .env, or
 * one predating the key) — there the CLI default is the right guess. A present
 * but unparseable value instead throws: silently probing 3502 could roll back a
 * healthy upgrade, or worse, report success against an unrelated instance that
 * happens to be listening there.
 */
function readInstalledPort(dir: string): number | null {
  let env: string
  try {
    env = readFileSync(join(dir, '.env'), 'utf-8')
  } catch {
    return null
  }
  const match = env.match(/^A2WAVE_PORT=(.*)$/m)
  if (!match) return null
  const raw = match[1].trim()
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(
      // Deliberately does not suggest --port: an upgrade rejects that flag,
      // so pointing at it would send the user into a second error.
      `Invalid A2WAVE_PORT in ${join(dir, '.env')}: ${JSON.stringify(raw)}. Fix that value before upgrading.`,
    )
  }
  return port
}

/**
 * Build the compose handle for an existing install from its own `.env`.
 *
 * Both pins come from the file rather than the environment, which is the whole
 * point: the operator's shell may export either key, and compose prefers the
 * environment over `.env`.
 *
 * A malformed `A2WAVE_PORT` degrades to null here instead of throwing.
 * `readInstalledPort` throws for the upgrade path, where probing the wrong port
 * could roll back a healthy release — but for a probe or a `compose exec` the
 * only effect of null is that compose falls back to the file's own
 * `${A2WAVE_PORT:-<installPort>}` default, which is exactly right.
 */
function readInstallEnv(dir: string, projectName: string): Install {
  let env = ''
  try {
    env = readFileSync(join(dir, '.env'), 'utf-8')
  } catch {
    // Unreadable .env: pin nothing, let the compose file's defaults decide.
  }
  let port: number | null = null
  try {
    port = readInstalledPort(dir)
  } catch {
    port = null
  }
  return { dir, projectName, image: readEnvImage(env), port }
}

function tailContainerLogs(install: Install): string {
  try {
    return composeExec(install, 'logs --tail 50 a2wave', { stdio: 'pipe' }).trim()
  } catch {
    return `(could not read container logs — run manually: docker compose -p ${install.projectName} logs a2wave)`
  }
}

/** True when the container has already died — waiting for health is pointless. */
function containerHasExited(install: Install): boolean {
  try {
    // --all: compose v2 hides stopped containers by default, so without it a
    // genuinely exited container would be invisible and this guard dead code.
    const out = composeExec(install, 'ps --all --format json a2wave', { stdio: 'pipe' })
    return /"State"\s*:\s*"(exited|dead|restarting)"/i.test(out)
  } catch {
    // ps failing is not itself proof of death; let the health deadline decide
    return false
  }
}

/**
 * Wait until the instance reports readiness, not merely liveness.
 *
 * `/api/health` turns green as soon as the port is open, but the API keeps
 * seeding afterwards and only then marks itself ready — so treating liveness as
 * success accepts an upgrade during a window where seeding can still fail and
 * take the process down, with nothing left to trigger a rollback.
 *
 * A 404 means the deployed image predates the readiness route; such images must
 * stay upgradable, so that is accepted rather than polled to death.
 */
async function waitForReady(
  baseUrl: string,
  timeoutSeconds: number,
  install: Install,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health/ready`, {
        signal: AbortSignal.timeout(probeTimeoutMs(deadline)),
      })
      if (res.ok) return
      if (res.status === 404) return
    } catch {
      // not reachable yet — keep polling until the deadline
    }
    if (containerHasExited(install)) {
      throw healthFailureError(
        `The a2wave container exited or is crash-looping before becoming ready (${baseUrl}/api/health/ready).`,
        baseUrl,
        install,
      )
    }
    if (Date.now() >= deadline) {
      throw healthFailureError(
        `The container is running but never became ready within ${timeoutSeconds}s (${baseUrl}/api/health/ready still reports "starting"). Boot-time seeding has not finished.`,
        baseUrl,
        install,
      )
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
}

function healthFailureError(reason: string, baseUrl: string, install: Install): CliError {
  const logs = tailContainerLogs(install)
  return new CliError(
    [
      reason,
      '',
      '--- last container logs (docker compose logs --tail 50 a2wave) ---',
      logs,
      '---',
      'Common causes: image architecture mismatch (arm64 host pulling an amd64-only image — check `uname -m`),',
      `or the image tag not existing yet. Follow live logs with: docker compose -p ${install.projectName} logs -f a2wave`,
    ].join('\n'),
  )
}

async function waitForHealth(
  baseUrl: string,
  timeoutSeconds: number,
  install: Install,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000
  // First probe fires immediately so tests with timeout=0 still exercise one attempt
  let sawDegraded = false
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(probeTimeoutMs(deadline)),
      })
      if (res.ok) {
        // The API returns HTTP 200 with status:"degraded" when DB/disk checks
        // fail — that is not a successful install. Keep polling in case it is
        // transient (e.g. first-boot migration), but never accept it as ok.
        const body = (await res.json().catch(() => null)) as { status?: string } | null
        if (body?.status === 'ok') return
        sawDegraded = true
      }
    } catch {
      // service not up yet — keep polling until the deadline
    }
    // A crashed/crash-looping container will never become healthy — fail now
    // instead of burning the whole timeout.
    if (containerHasExited(install)) {
      throw healthFailureError(
        `The a2wave container exited or is crash-looping (${baseUrl}/api/health never came up).`,
        baseUrl,
        install,
      )
    }
    if (Date.now() >= deadline) {
      // Ship the diagnosis with the failure: most setup bug reports would
      // otherwise contain only "health check timed out".
      throw healthFailureError(
        sawDegraded
          ? `The platform came up but stayed degraded (status:"degraded" from ${baseUrl}/api/health) — its database or storage checks are failing.`
          : `Health check did not pass within ${timeoutSeconds}s (${baseUrl}/api/health).`,
        baseUrl,
        install,
      )
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
}

/**
 * Ownership marker written by setup. Teardown refuses to act on a directory
 * without it — the presence of some docker-compose.yml alone must never be
 * enough to `down -v` + rm -rf a directory that may belong to another project.
 */
const INSTALL_MARKER = '.a2wave-install'

function teardown(dir: string, destroyConfirmed: boolean): Promise<void> {
  return (async () => {
    const composePath = join(dir, 'docker-compose.yml')
    if (!existsSync(composePath)) {
      throw new CliError(
        `No a2wave install found at ${dir} (missing docker-compose.yml). Use --dir to point at the install directory.`,
      )
    }
    if (!existsSync(join(dir, INSTALL_MARKER))) {
      throw new CliError(
        [
          `Refusing teardown: ${dir} has no ${INSTALL_MARKER} marker, so it was not created by \`a2wave setup\`.`,
          'Tearing it down would destroy a directory (and its docker volumes) that may belong to another project.',
        ].join('\n'),
      )
    }
    // Fail closed: without the trusted per-install project name, `down -v`
    // would resolve the project from the environment/basename — under an
    // external COMPOSE_PROJECT_NAME that means deleting ANOTHER project's
    // volumes. Never fall back to a bare compose command for destruction.
    const projectName = readProjectName(dir)
    if (!projectName) {
      throw new CliError(
        [
          `Refusing teardown: could not read a trusted COMPOSE_PROJECT_NAME from ${join(dir, '.env')}.`,
          'Without it, `docker compose down -v` may target a different project and delete its data.',
          'Restore the COMPOSE_PROJECT_NAME line in that .env (see the value in `docker compose ls`), then retry.',
        ].join('\n'),
      )
    }
    // Irreversible: --yes deliberately does NOT satisfy this gate. Either the
    // explicit --yes-destroy-all-data flag, or typing the install dir path.
    if (!destroyConfirmed) {
      if (!process.stdin.isTTY) {
        throw new CliError(
          [
            'Teardown deletes the container, the data volume, and the install directory — irreversibly.',
            'Non-interactive use requires the explicit flag: a2wave setup --down --yes-destroy-all-data',
          ].join('\n'),
        )
      }
      const ok = await confirmByTyping(
        `This stops the container AND PERMANENTLY DELETES ALL DATA (docker volume + ${dir}).`,
        dir,
      )
      if (!ok) {
        console.log('Aborted — confirmation phrase did not match.')
        return
      }
    }
    try {
      // Both keys deleted rather than pinned: teardown destroys the stack, so
      // there is nothing to keep serving on a particular port or image, and an
      // inherited value could only make compose fail during interpolation.
      composeExec({ dir, projectName, image: null, port: null }, 'down -v', { stdio: 'inherit' })
    } catch {
      throw new CliError(
        `docker compose down failed — the install directory was left untouched. Retry with: cd ${shellQuote(dir)} && docker compose -p ${projectName} down -v`,
      )
    }
    rmSync(dir, { recursive: true, force: true })
    console.log(`✔ a2wave removed: container stopped, data volume deleted, ${dir} removed.`)
  })()
}

/** Path of the recovery script inside the image (built by `apps/api` build). */
const RESET_SCRIPT = '/app/apps/api/dist/scripts/set-admin-password.js'

/**
 * Whether the service container is currently up. Asked of docker rather than
 * inferred from a failed `exec`: with stdio inherited, compose's own "is not
 * running" goes to the terminal and never reaches the error object.
 */
function isContainerRunning(install: Install): boolean {
  try {
    const out = composeExec(install, 'ps --format json a2wave', { stdio: 'pipe' })
    return /"State"\s*:\s*"running"/i.test(out)
  } catch {
    // docker missing, daemon down, or the project unknown — all "cannot reach it"
    return false
  }
}

/**
 * Run the in-image admin-password recovery script against a running install.
 *
 * The password is prompted for by the script inside the container, not here:
 * stdio is inherited so the masked prompt owns the terminal directly, and the
 * value never passes through this process, argv, or the environment.
 */
/**
 * Read the install's identity, or fail closed.
 *
 * Shared by the teardown, reset-password and upgrade paths: all three act on an
 * existing install, so all three must refuse a directory that `a2wave setup`
 * did not create and one whose trusted Compose project name cannot be read.
 * Without the latter, every compose invocation would resolve the project from
 * the environment or the directory basename — i.e. potentially another
 * install's containers and volumes.
 */
function readInstall(dir: string, action: string): { composePath: string; projectName: string } {
  const composePath = join(dir, 'docker-compose.yml')
  if (!existsSync(composePath)) {
    throw new CliError(
      `No a2wave install found at ${dir} (missing docker-compose.yml). Use --dir to point at the install directory.`,
    )
  }
  if (!existsSync(join(dir, INSTALL_MARKER))) {
    throw new CliError(
      `Refusing ${action}: ${dir} has no ${INSTALL_MARKER} marker, so it was not created by \`a2wave setup\`.`,
    )
  }
  const projectName = readProjectName(dir)
  if (!projectName) {
    throw new CliError(
      [
        `Refusing ${action}: could not read a trusted COMPOSE_PROJECT_NAME from ${join(dir, '.env')}.`,
        'Without it, compose would resolve the project from the environment and could target a different install.',
        'Restore the COMPOSE_PROJECT_NAME line in that .env (see the value in `docker compose ls`), then retry.',
      ].join('\n'),
    )
  }
  return { composePath, projectName }
}

/**
 * Run the in-image admin-password recovery script against a running install.
 *
 * The password is prompted for by the script inside the container, not here:
 * stdio is inherited so the masked prompt owns the terminal directly, and the
 * value never passes through this process, argv, or the environment.
 */
function resetAdminPassword(dir: string): void {
  const { projectName } = readInstall(dir, 'password reset')
  // Read from the install rather than inherited: compose interpolates the file
  // even for `exec`, so a malformed A2WAVE_PORT in the caller's shell would
  // fail the call and send the operator to "start the container" for one that
  // is plainly running.
  const install = readInstallEnv(dir, projectName)
  try {
    // `exec` bypasses docker-entrypoint.sh (and the gosu drop it performs), so
    // it defaults to root even though the main process runs as appuser —
    // --user pins it back to the same non-root account the server itself uses.
    composeExec(install, `exec --user appuser a2wave node ${RESET_SCRIPT}`, {
      // inherit: the script draws its own masked prompt and needs the TTY
      stdio: 'inherit',
    })
  } catch {
    // `compose exec` passes the script's exit code straight through, so a
    // non-zero status covers two very different situations. The script already
    // printed its own reason to the inherited stderr, so repeating a guess
    // here — especially "start the container" for a container that is plainly
    // running — sends the user the wrong way.
    //
    // stdio is 'inherit', so compose's own message went to the terminal and is
    // NOT on the error object; asking docker directly is the only reliable way
    // to tell "could not reach the container" from "the script said no".
    throw new CliError(
      !isContainerRunning(install)
        ? [
            `Could not reach the a2wave container in ${dir}.`,
            `Start it first: cd ${shellQuote(dir)} && docker compose -p ${projectName} up -d`,
            'If docker itself is missing, install it: https://docs.docker.com/get-docker/',
          ].join('\n')
        : [
            'The recovery script exited without setting the password (see its output above).',
            'Common causes: the two entries did not match, the password failed the policy',
            '(min 8 chars, upper + lower + digit), or the image predates this command and',
            'carries no recovery script — in that case rebuild the image and redeploy.',
          ].join('\n'),
    )
  }
}

/** Sentinel: /app/data is a bind mount, so there is no volume to archive. */
const BIND_MOUNTED = '\0bind'

/**
 * Name of the volume the a2wave container actually mounts at /app/data.
 *
 * Deliberately asked of Docker rather than derived as `<project>_a2wave-data`:
 * the documented recovery procedure switches the compose file to
 * `external: true` + `name: <project>_a2wave-restore`, and a guessed name would
 * then archive the OLD volume. Worse, `docker run -v <missing>` CREATES the
 * volume instead of failing, so once the old one is gone the guess produces a
 * 3-byte "successful" backup while the upgrade proceeds believing it is safe.
 *
 * Returns null when the mount cannot be identified; the caller must fail rather
 * than fall back to a guess.
 */
function resolveDataVolume(install: Install): string | null {
  try {
    const psOut = composeExec(install, 'ps --all --format json a2wave', { stdio: 'pipe' })
    // Compose emits NDJSON — one object per line — and with --all a replaced or
    // exited container can come first. Prefer a running one; otherwise take the
    // last entry, which is the most recently created.
    const entries = psOut
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown
          return Array.isArray(parsed) ? parsed : [parsed]
        } catch {
          return []
        }
      }) as Array<{ Name?: string; State?: string }>
    const container = (entries.find((e) => e.State === 'running') ?? entries.at(-1))?.Name
    if (!container) return null

    // The format string contains a space, so it MUST be quoted: unquoted, the
    // shell splits it and docker reports "unclosed action" — swallowed by the
    // catch below, which degraded every real run to the guessed name this
    // resolution exists to replace.
    const mountsOut = execSync(
      `docker inspect ${shellQuote(container)} --format ${shellQuote('{{json .Mounts}}')}`,
      { stdio: 'pipe', encoding: 'utf-8' },
    )
    const mounts = JSON.parse(mountsOut) as Array<{
      Type?: string
      Name?: string
      Destination?: string
    }>
    const dataMount = mounts.find((m) => m.Destination === '/app/data')
    if (!dataMount) return null
    // A bind mount has no Name and cannot be archived by volume. Returning null
    // would fall back to the conventional volume — archiving something the
    // container is not even using — so signal it distinctly.
    if (!dataMount.Name) return BIND_MOUNTED
    return dataMount.Name
  } catch {
    return null
  }
}

/**
 * Snapshot the install's data volume to a tarball in the install directory.
 *
 * An upgrade is the one routine operation that can lose data: a new image may
 * apply an irreversible migration the previous version cannot read, so rolling
 * the *image* back does not roll the *database* back. The volume is never
 * deleted by this command, but "not deleted" is not "recoverable".
 *
 * The container is stopped first — copying a live SQLite file can capture a
 * torn write — which costs nothing here because `up -d` recreates it anyway.
 */
function backupDataVolume(dir: string, volume: string, stamp: string): string {
  const file = `a2wave-data-${stamp}.tar.gz`
  try {
    execSync(
      // --user: without it tar runs as root inside the container and the bind
      // mount lands a root:root 0644 archive on the host, which a non-root CLI
      // user then cannot chmod — leaving a world-readable copy of the whole
      // database. Writing as the caller makes the file ours from the start.
      `docker run --rm --user ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} -v ${shellQuote(volume)}:/data:ro -v ${shellQuote(dir)}:/backup alpine tar czf ${shellQuote(`/backup/${file}`)} -C /data .`,
      { stdio: 'pipe' },
    )
  } catch (err) {
    throw new CliError(
      [
        `Backup of the data volume failed, so the upgrade was not started: ${(err as Error).message.split('\n')[0]}`,
        'Free up disk space and retry, or skip the snapshot with --no-backup if you manage backups yourself.',
      ].join('\n'),
    )
  }
  // The archive holds the SQLite database — credentials, tokens, every secret
  // the platform stores. Alpine's default umask (0022) would leave it 0644, so
  // lock it down like the generated .env. Deliberately NOT best-effort: a
  // swallowed failure here leaves that snapshot readable by every local user
  // while the upgrade reports success, which is the exact regression this
  // guards against.
  try {
    chmodSync(join(dir, file), 0o600)
  } catch (err) {
    throw new CliError(
      [
        `The backup was written but could not be restricted to owner-only: ${(err as Error).message.split('\n')[0]}`,
        `It contains the full database. Delete or secure ${join(dir, file)} before continuing.`,
        'Re-run with --no-backup if you manage snapshots yourself.',
      ].join('\n'),
    )
  }
  pruneBackups(dir)
  return file
}

/** How many volume snapshots to keep in an install directory. */
const BACKUP_RETENTION = 3

/**
 * Drop all but the newest BACKUP_RETENTION archives.
 *
 * Each one is a full copy of the database — provider credentials, gateway
 * tokens, password hashes — so keeping every upgrade's snapshot both grows
 * without bound and multiplies what a single directory leak exposes. The names
 * embed an ISO timestamp, so a lexical sort is chronological.
 */
function pruneBackups(dir: string): void {
  // Match ONLY the generator's own timestamp shape (ISO 8601 with `:`/`.`
  // replaced by `-`). A loose `.*` also matched deliberately kept copies like
  // `a2wave-data-baseline.tar.gz` and deleted them silently.
  const pattern = /^a2wave-data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar\.gz$/
  try {
    const archives = readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort()
    for (const stale of archives.slice(0, -BACKUP_RETENTION)) {
      rmSync(join(dir, stale), { force: true })
    }
  } catch {
    // Pruning is housekeeping: never fail an otherwise good upgrade over it.
  }
}

/**
 * Upgrade an existing install to a new image, in place.
 *
 * Data safety is the whole point of this path, so three things it deliberately
 * never does:
 *   - pass `-v` / `--volumes` to compose (that deletes the database volume)
 *   - rewrite `.env` (a fresh AUTH_SECRET invalidates every session; a fresh
 *     COMPOSE_PROJECT_NAME silently points compose at a DIFFERENT volume and
 *     orphans the real data while still looking like a success)
 *   - regenerate docker-compose.yml (it would discard local customizations)
 *
 * Only the `image:` line moves. If the new image fails its health check the
 * previous compose file is restored and brought back up, so a bad release
 * leaves a running instance rather than a dead one.
 */
async function upgrade(
  dir: string,
  image: string,
  timeoutSeconds: number,
  /** Host port recorded in the install .env, or null when the key is absent. */
  recordedPort: number | null,
  backup: boolean,
  /** Timestamp for the backup filename; injected so it stays testable. */
  stamp: string,
): Promise<void> {
  const { projectName } = readInstall(dir, 'upgrade')
  // The health probe still needs a concrete port; the CLI default is the right
  // guess when .env recorded none. It is deliberately NOT pushed into compose's
  // environment — see the `env` handling in `compose` below.
  const port = recordedPort ?? DEFAULT_PORT

  // The image lives in .env as A2WAVE_IMAGE; docker-compose.yml only reads it
  // via `${A2WAVE_IMAGE:-<default>}`. That is what makes this command safe:
  // swapping an image is a single env-key edit with no YAML to understand,
  // where rewriting a line inside the compose file previously required parsing
  // YAML with regexes and mis-targeted the wrong service in six distinct
  // valid-compose shapes.
  // Legacy installs hardcode the ref in docker-compose.yml, where the env key
  // below would be ignored — migrate that line to the variable first, or the
  // upgrade would report success while the container stayed on the old image.
  const composePath = join(dir, 'docker-compose.yml')
  const composeBefore = readFileSync(composePath, 'utf-8')
  let composeMigrated: string | null
  try {
    composeMigrated = migrateComposeImageToVariable(composeBefore)
  } catch (err) {
    // Hand-edited layout: refuse rather than guess which line is a2wave's.
    // Nothing has moved yet, so the install is untouched.
    throw new CliError((err as Error).message)
  }
  if (composeMigrated) {
    writeFileSync(composePath, composeMigrated, 'utf-8')
    console.log('Migrated docker-compose.yml to read the image from .env')
  }

  const envPath = join(dir, '.env')
  const before = readFileSync(envPath, 'utf-8')
  const currentImage = readEnvImage(before)
  const after = replaceEnvImage(before, image)

  // Deliberately no early return when the ref is unchanged. `--image` is
  // documented as a locally built tag (a2wave:latest), so an equal string says
  // nothing about the image behind it — returning early skipped pull, recreate,
  // health and rollback exactly in the rebuild-then-upgrade flow the docs
  // recommend. It also stranded an upgrade interrupted after the rewrite but
  // before the recreate. `pull` and `up -d` are both idempotent.
  console.log(
    currentImage === null
      ? `Setting image to ${image}`
      : currentImage === image
        ? `Re-applying ${image} (same ref — a mutable tag may point at a new image)`
        : `Upgrading ${currentImage} → ${image}`,
  )

  // Every compose call is scoped to the a2wave service: a bare `pull` / `up -d`
  // acts on the whole project, so a hand-added sidecar would be pulled to a new
  // image and recreated by what the user asked to be an a2wave upgrade.
  //
  // A2WAVE_PORT is pinned to the value recorded in the install .env because
  // Compose reads the environment ahead of that file — an exported A2WAVE_PORT
  // in the caller's shell would publish the container on a different port while
  // this command still probes the recorded one, producing a false rollback.
  // When the install recorded none, the key is deleted rather than defaulted:
  // injecting a guess would beat the compose file's own
  // `${A2WAVE_PORT:-<installPort>}` fallback and republish the container.
  //
  // The image pinned by default is the one being upgraded TO; every call that
  // needs a different ref (the rollback, the pre-backup stop) passes `image`
  // explicitly.
  const install: Install = { dir, projectName, image, port: recordedPort }

  const compose = (subcommand: string, pinnedImage: string | null = image) =>
    composeExec(install, `${subcommand} a2wave`, { stdio: 'inherit', image: pinnedImage })

  const manualRecovery = `Recover manually with: cd ${shellQuote(dir)} && docker compose -p ${projectName} up -d --no-deps a2wave`

  // Set once the container has been stopped for the snapshot: from that point
  // on, ANY abort must start it again, or the command leaves the install down
  // while telling the operator nothing was touched.
  let stoppedForBackup = false
  /** True once abort() has run, so a caller can tell its error from any other. */
  let aborted = false
  /** Undo whatever has been done so far and surface `message`. */
  const abort = (message: string): never => {
    aborted = true
    if (composeMigrated) writeFileSync(composePath, composeBefore, 'utf-8')
    if (stoppedForBackup) {
      console.log('Restarting the previous container ...')
      try {
        // Pass the previous ref when known; null lets compose resolve it from
        // the restored .env — pinning `image` here would re-start the very
        // image that just failed. Either way this goes through compose() so the
        // environment is sanitized exactly like every other invocation.
        compose('up -d --no-deps', currentImage ?? null)
      } catch {
        throw new CliError(
          [message, '', `WARNING: the container could not be restarted. ${manualRecovery}`].join(
            '\n',
          ),
        )
      }
    }
    throw new CliError(message)
  }

  if (backup) {
    // Stop first: a live SQLite file can be captured mid-write. `up -d` below
    // recreates the container regardless, so this costs no extra downtime.
    console.log('Stopping the container to take a consistent snapshot ...')
    try {
      // Through compose() so the environment is sanitized like every other
      // call: a malformed inherited A2WAVE_PORT makes compose fail during
      // interpolation, and the tar below would then copy a LIVE database.
      compose('stop', currentImage ?? null)
      stoppedForBackup = true
    } catch {
      // Fail closed. A swallowed stop means tar packs a file SQLite is still
      // writing, and the resulting DB/WAL/SHM set can be unrecoverable — a
      // backup that cannot be restored is worse than no backup, because the
      // upgrade proceeds believing it has one.
      // Through abort() so a compose file already rewritten by the legacy
      // migration is restored: the message says the upgrade was not started,
      // and that must be true of the operator's files too.
      abort(
        [
          'Could not stop the container before taking the snapshot, so the upgrade was not started.',
          'Backing up a running database risks an unrestorable copy.',
          `Check it with: cd ${shellQuote(dir)} && docker compose -p ${projectName} ps a2wave`,
          'Or skip the snapshot with --no-backup if you manage backups yourself.',
        ].join('\n'),
      )
    }
    try {
      // Resolved from the stopped container, never guessed: an install moved to
      // an external volume by the recovery guide would otherwise archive the
      // wrong one — or an empty one docker silently creates.
      //
      // There is deliberately NO fallback to `<project>_a2wave-data`. That
      // guess looks safe because the name is checked for existence first, but
      // existence is not the question: the recovery guide moves an install onto
      // `<project>_a2wave-restore` while leaving the old conventional volume in
      // place, so "it exists" is true of exactly the stale volume. The upgrade
      // would then archive last month's data, report a good snapshot, and apply
      // an irreversible migration with nothing to restore from. Whenever the
      // mount cannot be proven, this fails closed instead.
      const resolved = resolveDataVolume(install)
      if (resolved === BIND_MOUNTED) {
        abort(
          [
            'The a2wave container mounts /app/data from a host directory, not a docker volume, so this command cannot snapshot it.',
            'Back that directory up yourself, then re-run with --no-backup.',
          ].join('\n'),
        )
      }
      if (!resolved) {
        // `throw` rather than a bare call so the compiler narrows `resolved`
        // below — abort() already throws, so this only restates it for tsc.
        throw abort(
          [
            'Could not determine which volume the a2wave container mounts at /app/data, so no backup was taken.',
            'Guessing the name risks archiving the wrong volume — an install moved to an external',
            'restore volume still has the old conventional one sitting next to it — or an empty one,',
            'which docker would create silently.',
            `Check it with: docker compose -p ${projectName} ps --all a2wave`,
            'Or skip the snapshot with --no-backup if you manage backups yourself.',
          ].join('\n'),
        )
      }
      const file = backupDataVolume(dir, resolved, stamp)
      console.log(`Backed up ${resolved} to ${join(dir, file)}`)
    } catch (err) {
      // abort() has already restarted the container and marked its error, so
      // re-entering it would restart twice and could print a stale "could not
      // be restarted" warning. Everything else happened after the stop and
      // still needs abort() to bring the instance back.
      if (err instanceof CliError && aborted) throw err
      abort((err as Error).message)
    }
  }

  // Identity of the image the container is ACTUALLY running, captured before
  // anything moves. Read from the container itself, not from `compose images`
  // — the latter reports what compose resolves the tag to *now*, which for a
  // moving tag is already the new (possibly broken) image.
  //
  // With a mutable tag (`a2wave:latest`, the documented local-build flow) the
  // compose text is byte-identical before and after, so restoring the file and
  // running `up -d` would re-resolve the tag to the same failing image — a
  // rollback in name only. Null when nothing is running or docker cannot
  // answer; the rollback then degrades to restoring the tag, which is still
  // correct whenever the ref genuinely changed.
  const runningImageId = ((): string | null => {
    try {
      // --all: the backup step stops the container before this runs, and
      // compose hides stopped containers by default — without it the pin is
      // always null and a same-tag rollback re-resolves to the failing image.
      const out = composeExec(install, 'ps --all --format json a2wave', { stdio: 'pipe' })
      const name = out.match(/"Name"\s*:\s*"([^"]+)"/)?.[1]
      if (!name) return null
      const id = execSync(`docker inspect ${shellQuote(name)} --format {{.Image}}`, {
        stdio: 'pipe',
        encoding: 'utf-8',
      }).trim()
      return id.startsWith('sha256:') ? id : null
    } catch {
      return null
    }
  })()

  /**
   * A bare `sha256:...` digest is not a usable compose `image:` value — compose
   * reads it as a repository named "sha256" and tries to pull it. Give the
   * captured image an immutable local tag instead, which is a normal reference
   * compose can resolve offline. Returns null if tagging fails.
   */
  const pinRollbackTag = (id: string): string | null => {
    const tag = `a2wave:rollback-${id.replace('sha256:', '').slice(0, 12)}`
    try {
      execSync(`docker tag ${shellQuote(id)} ${shellQuote(tag)}`, { stdio: 'pipe' })
      return tag
    } catch {
      return null
    }
  }

  /**
   * Put the install back on the previous image and confirm it actually serves.
   *
   * Returns the line to append to the failure message. `up -d` exiting 0 only
   * means compose started a container — the old image can still crash (for
   * instance when the new one already applied an irreversible migration), so
   * the rollback is only reported as successful once health passes. Anything
   * else says plainly that manual work is needed.
   */
  const rollBack = async (): Promise<string> => {
    // When the ref did not change, restoring `before` would point compose at
    // the same moving tag — i.e. back at the image that just failed. Pin the
    // digest captured before the upgrade instead, so the rollback actually
    // returns to the version that was serving.
    // Pin whenever the previous image was captured — never gate on the refs
    // being equal strings. `a2wave` and `a2wave:latest` differ textually yet
    // resolve to the same moving tag, and any old tag may have been rebuilt or
    // re-pulled since; in both cases restoring the old text would resolve to
    // the image that just failed. The captured id is the only thing that
    // reliably names the version that was actually serving.
    const pinned = runningImageId ? pinRollbackTag(runningImageId) : null
    const restored = pinned ? replaceEnvImage(before, pinned) : before
    // The value handed to compose and the text shown to the operator are two
    // different things: passing the placeholder as a ref sets an illegal
    // A2WAVE_IMAGE and guarantees the rollback cannot start, even though the
    // compose file's own fallback would have worked. null → key deleted.
    const restoreRef = pinned ?? currentImage ?? null
    const target = restoreRef ?? 'the previous image'
    if (!pinned) {
      console.log(
        `\nWARNING: the previously running image could not be pinned, so restoring ${currentImage} may re-resolve to the failing image.`,
      )
    }
    console.log(`\nRolling back to ${target} ...`)
    writeFileSync(envPath, restored, 'utf-8')
    try {
      compose('up -d --no-deps', restoreRef)
    } catch {
      return `WARNING: the rollback to ${target} could not be started. ${manualRecovery}`
    }
    try {
      // Share the user's budget across the two rollback probes instead of
      // giving each a fresh one: a failed upgrade already spent it once, and
      // four full timeouts is not what `--health-timeout` promises.
      const rollbackBudget = Math.max(1, timeoutSeconds / 2)
      // The probes run `compose ps`/`logs` against the ROLLED-BACK install, so
      // they must pin the ref that was just restored — pinning `image` would
      // have compose resolve the failed one while diagnosing the old container.
      const rolledBack: Install = { ...install, image: restoreRef }
      await waitForHealth(`http://localhost:${port}`, rollbackBudget, rolledBack)
      await waitForReady(`http://localhost:${port}`, rollbackBudget, rolledBack)
    } catch {
      return [
        `WARNING: rolled back to ${target}, but it did not come back healthy.`,
        'The new image may have applied a migration the previous version cannot read.',
        `Your data volume was not deleted. ${manualRecovery}`,
      ].join('\n')
    }
    return [
      `Rolled back to ${target} and it is healthy again; your data volume was not touched.`,
      pinned
        ? `Note: .env now pins the local tag ${pinned}, which only exists on this host. Set A2WAVE_IMAGE back to a pullable ref (e.g. ${currentImage ?? 'your previous image'}) before moving or rebuilding this install.`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  writeFileSync(envPath, after, 'utf-8')
  try {
    // Pull first so a bad tag fails before the running container is touched.
    // But a pull failure is only fatal when the image is absent locally: until
    // a public registry ships, `--image` is normally a locally built tag that
    // exists in the daemon and can never be pulled from anywhere.
    try {
      compose('pull')
    } catch {
      try {
        execSync(`docker image inspect ${shellQuote(image)}`, { stdio: 'pipe' })
        console.log(`(pull failed; using the local image ${image})`)
      } catch {
        // Nothing has been recreated yet, but the backup path may already have
        // stopped the container — `abort` puts the env file, the compose file
        // and the running container all back.
        writeFileSync(envPath, before, 'utf-8')
        abort(
          [
            `Image ${image} could not be pulled and is not present locally.`,
            'Check the tag, or build it first (e.g. `docker compose build`).',
          ].join('\n'),
        )
      }
    }
    compose('up -d --no-deps')
  } catch (err) {
    // `compose up -d` replaces the service: it stops the old container before
    // the new one is running, so a failure here leaves the install DOWN.
    // Restoring the file alone would turn a failed upgrade into an outage —
    // the old version has to be started again.
    // A CliError is our own pre-flight diagnosis (image absent locally), thrown
    // before anything was recreated — it already restored the file and says
    // what to do, so it must not trigger a rollback cycle.
    if (err instanceof CliError) throw err
    throw new CliError(
      [`Upgrade to ${image} failed while starting the new container.`, '', await rollBack()].join(
        '\n',
      ),
    )
  }

  const localUrl = `http://localhost:${port}`
  console.log(`Waiting for ${localUrl}/api/health ...`)
  try {
    await waitForHealth(localUrl, timeoutSeconds, install)
    // Liveness only means the port is open; seeding runs after that and can
    // still fail, so the upgrade is not successful until the instance is ready.
    await waitForReady(localUrl, timeoutSeconds, install)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliError([message, '', await rollBack()].join('\n'))
  }

  console.log(`\n✔ a2wave upgraded to ${image}`)
}

export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    agentMeta: { risk: 'write' },
    description:
      'Install a local a2wave platform: generate .env + docker-compose.yml, start the container, and wait until healthy. Use --upgrade to move an existing install to a new image, or --down to uninstall.',
  },
  args: {
    dir: {
      type: 'string',
      description: `Install directory for the generated files (default: ${join('~', 'a2wave')})`,
    },
    port: {
      type: 'string',
      description: `Host port to expose the platform on (default: ${DEFAULT_PORT})`,
    },
    image: {
      type: 'string',
      description: `Container image to deploy (default: ${DEFAULT_IMAGE})`,
    },
    yes: {
      type: 'boolean',
      description: 'Non-interactive: accept all defaults without prompting',
    },
    start: {
      type: 'boolean',
      default: true,
      description: 'Start the container after generating files (--no-start to skip)',
    },
    down: {
      type: 'boolean',
      description:
        'Uninstall: docker compose down -v + remove the install directory (requires typed confirmation)',
    },
    backup: {
      type: 'boolean',
      default: true,
      description:
        'Snapshot the data volume into the install directory before upgrading (--no-backup to skip)',
    },
    upgrade: {
      type: 'boolean',
      description:
        'Upgrade an existing install to --image in place: rewrites only the image line, keeps .env and the data volume, and rolls back if the new image fails its health check',
    },
    'yes-destroy-all-data': {
      type: 'boolean',
      description:
        'Skip the --down confirmation. DESTROYS the container, data volume, and install directory irreversibly',
    },
    'base-url': {
      type: 'string',
      description:
        'External URL the instance is reached at (default: http://localhost:<port>). Set for LAN/reverse-proxy installs; drives CORS_ORIGIN and cookie security',
    },
    'database-url': {
      type: 'string',
      description:
        'External PostgreSQL URL (postgres://user:password@host:5432/dbname). EXPERIMENTAL backend; no SQLite -> PostgreSQL data migration. Default: SQLite inside the data volume',
    },
    'with-postgres': {
      type: 'boolean',
      description:
        'Bundle a postgres:16-alpine sidecar and point DATABASE_URL at it (EXPERIMENTAL; generates the password into .env)',
    },
    'health-timeout': {
      type: 'string',
      description: `Seconds to wait for /api/health after start (default: ${HEALTH_TIMEOUT_SECONDS})`,
    },
    'reset-password': {
      type: 'boolean',
      description:
        'Recover a forgotten admin password: prompt for a new one inside the running container (takes effect immediately, no restart)',
    },
  },
  run: async (ctx) => {
    assertKnownOptions(
      ctx.rawArgs ?? [],
      (ctx.cmd.args ?? {}) as Record<string, { alias?: string | string[] }>,
    )
    const args = (ctx?.args ?? {}) as {
      dir?: string
      port?: string
      image?: string
      yes?: boolean
      start?: boolean
      down?: boolean
      upgrade?: boolean
      backup?: boolean
      'yes-destroy-all-data'?: boolean
      'base-url'?: string
      'database-url'?: string
      'with-postgres'?: boolean
      'health-timeout'?: string
      'reset-password'?: boolean
    }

    // Recovery path: acts on an existing install, so it runs before any of the
    // generation preflight (no image needed, nothing written).
    if (args.upgrade) {
      // Checked BEFORE any mode branch: each of these dispatches and returns on
      // its own, so an exclusion placed after them would be unreachable and the
      // combination would silently run the other mode instead of being refused.
      // --base-url and --port only ever land in .env, which an upgrade
      // deliberately never rewrites, and --no-start contradicts an operation
      // whose whole purpose is to recreate the container.
      const conflicting = (
        [
          ['--down', args.down],
          ['--reset-password', args['reset-password']],
          ['--base-url', args['base-url'] !== undefined],
          ['--database-url', args['database-url'] !== undefined],
          ['--with-postgres', args['with-postgres']],
          ['--port', args.port !== undefined],
          ['--no-start', args.start === false],
        ] as const
      ).filter(([, present]) => present)
      if (conflicting.length > 0) {
        throw new CliError(
          [
            `${conflicting.map(([name]) => name).join(', ')} cannot be combined with --upgrade.`,
            'An upgrade never rewrites .env, so it cannot change the port or base URL, and it always recreates the container.',
          ].join('\n'),
        )
      }
    }

    if (args['reset-password']) {
      // Refuse rather than pick one: silently ignoring --down would leave the
      // operator believing the install had been torn down.
      if (args.down) {
        throw new CliError('--reset-password and --down are mutually exclusive; pass only one.')
      }
      // There is no non-interactive way to supply the new password (by design
      // — see promptAndSetAdminPassword), so --yes has nothing to accept a
      // default for. Reject up front rather than let automation that
      // allocates a PTY discover a hidden prompt.
      if (args.yes) {
        throw new CliError(
          '--reset-password requires an interactive terminal and cannot be combined with --yes.',
        )
      }
      if (!process.stdin.isTTY) {
        throw new CliError(
          'Not a terminal: the recovery script needs an interactive prompt to read the new password.',
        )
      }
      resetAdminPassword(resolve(args.dir ?? join(homedir(), 'a2wave')))
      return
    }

    if (args.down) {
      const dir = resolve(args.dir ?? join(homedir(), 'a2wave'))
      await teardown(dir, !!args['yes-destroy-all-data'])
      return
    }

    checkDockerAvailable()

    // Validate every flag up front so nothing fails after files are written
    const timeoutSeconds = args['health-timeout']
      ? parseHealthTimeout(args['health-timeout'])
      : HEALTH_TIMEOUT_SECONDS
    // Defaults to the published GHCR image for this CLI version; `--image`
    // overrides it for a locally built or mirrored ref.
    const image = args.image?.trim() || DEFAULT_IMAGE
    try {
      validateImageRef(image)
    } catch (err) {
      throw new CliError((err as Error).message)
    }

    // The sidecar derives its own DATABASE_URL; accepting an external URL at
    // the same time would silently drop one of the two.
    if (args['database-url'] !== undefined && args['with-postgres']) {
      throw new CliError(
        '--database-url and --with-postgres are mutually exclusive: the bundled sidecar derives its own DATABASE_URL.',
      )
    }
    const externalDatabaseUrl = args['database-url']?.trim()
    if (externalDatabaseUrl !== undefined) {
      try {
        validateDatabaseUrl(externalDatabaseUrl)
      } catch (err) {
        throw new CliError((err as Error).message)
      }
    }

    if (args.upgrade) {
      // Conflicting flags (including --port) were already rejected up front,
      // before any mode branch could dispatch and return.
      const dir = resolve(args.dir ?? join(homedir(), 'a2wave'))
      // The install's own port is authoritative for the health probe: it was
      // chosen at install time and lives in .env, so re-deriving it from the
      // --port default would probe the wrong URL on a non-default install.
      // Distinguish a port genuinely recorded in .env from a guess: only the
      // former may be pushed into compose's environment (see `upgrade`).
      const recordedPort = readInstalledPort(dir)
      // The pre-upgrade backup archives the volume mounted at /app/data; a
      // PostgreSQL backend keeps the real data elsewhere (external server or
      // the sidecar's own volume), so stay honest about what the snapshot holds
      // before a possibly irreversible migration runs against that database.
      const upgradeEnvPath = join(dir, '.env')
      const recordedDatabaseUrl = existsSync(upgradeEnvPath)
        ? readEnvDatabaseUrl(readFileSync(upgradeEnvPath, 'utf-8'))
        : null
      if (recordedDatabaseUrl?.startsWith('postgres')) {
        console.log(
          'Note: this install runs on PostgreSQL. The pre-upgrade backup covers only the /app/data volume, NOT the PostgreSQL data — take a pg_dump first if you need a database snapshot.',
        )
      }
      await upgrade(
        dir,
        image,
        timeoutSeconds,
        recordedPort,
        args.backup !== false,
        new Date().toISOString().replace(/[:.]/g, '-'),
      )
      return
    }

    let dir = args.dir ?? join(homedir(), 'a2wave')
    let port = args.port ? parsePort(args.port) : DEFAULT_PORT
    if (!args.yes) {
      // Prompting into a pipe/CI would hang or exit silently with code 0 —
      // demand the explicit flag like the teardown path does.
      if (!process.stdin.isTTY) {
        throw new CliError(
          'Not a terminal: interactive prompts are unavailable. Re-run with --yes (plus --dir/--port to override defaults).',
        )
      }
      dir = await promptWithDefault('Install directory', dir)
      // Re-prompt on a typo instead of discarding the whole session
      for (;;) {
        const raw = await promptWithDefault('Host port', String(port))
        try {
          port = parsePort(raw)
          break
        } catch (err) {
          console.log((err as Error).message)
        }
      }
    }
    dir = resolve(dir)
    const baseUrl = args['base-url'] ? parseBaseUrl(args['base-url']) : `http://localhost:${port}`
    // Health always probes the local port: the container is on this machine,
    // while --base-url (reverse proxy / DNS) may not be routable yet.
    const localUrl = `http://localhost:${port}`

    const envPath = join(dir, '.env')
    const composePath = join(dir, 'docker-compose.yml')
    // Require a nonexistent or empty directory: setup takes ownership of the
    // whole dir (teardown recursively deletes it), so installing into a dir
    // with pre-existing files would put them in the blast radius of --down.
    if (existsSync(dir)) {
      const entries = readdirSync(dir)
      if (entries.length > 0) {
        const hasPriorInstall = entries.includes('.env') || entries.includes('docker-compose.yml')
        throw new CliError(
          hasPriorInstall
            ? [
                `Refusing to overwrite: ${dir} already contains an install (.env / docker-compose.yml).`,
                'If it is running: edit the generated files to reconfigure, then `docker compose up -d`.',
                `For a clean retry: a2wave setup --down --dir ${dir}`,
              ].join('\n')
            : [
                `Install directory is not empty: ${dir}`,
                'setup owns the whole directory (`setup --down` deletes it recursively),',
                'so it must start out empty. Pick a fresh directory with --dir.',
              ].join('\n'),
        )
      }
    }

    await checkPortFree(port)

    const authSecret = generateAuthSecret()
    const withPostgres = !!args['with-postgres']
    const postgresPassword = withPostgres ? generatePostgresPassword() : undefined
    // `postgres` is the sidecar's compose service name, resolvable only on the
    // compose network — which is exactly where the API container lives.
    const databaseUrl = withPostgres
      ? `postgres://a2wave:${postgresPassword}@postgres:5432/a2wave`
      : externalDatabaseUrl

    mkdirSync(dir, { recursive: true })
    const projectName = generateProjectName()
    writeFileSync(
      envPath,
      buildEnvFile({
        authSecret,
        port,
        baseUrl,
        projectName,
        image,
        databaseUrl,
        postgresPassword,
      }),
      {
        encoding: 'utf-8',
        mode: 0o600, // contains AUTH_SECRET
      },
    )
    chmodSync(envPath, 0o600) // like config.ts: writeFileSync mode is umask-filtered on some platforms
    writeFileSync(composePath, buildComposeFile({ image, port, withPostgres }), 'utf-8')
    // Ownership marker: teardown refuses directories without it
    writeFileSync(join(dir, INSTALL_MARKER), `created by a2wave setup v${getVersion()}\n`, 'utf-8')
    console.log(`Generated ${envPath}`)
    console.log(`Generated ${composePath}`)
    if (databaseUrl) {
      console.log(
        withPostgres
          ? 'Database: PostgreSQL sidecar (EXPERIMENTAL) — password generated into .env'
          : 'Database: external PostgreSQL (EXPERIMENTAL) — no SQLite data migration path',
      )
    }
    if (
      externalDatabaseUrl &&
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(externalDatabaseUrl).hostname)
    ) {
      console.log(
        'Warning: inside the container, localhost is the container itself — a database on this machine is reached as host.docker.internal (Docker Desktop) or the host IP.',
      )
    }

    if (args.start === false) {
      console.log('\nSkipped start (--no-start). To launch later:')
      console.log(`  cd ${shellQuote(dir)} && docker compose -p ${projectName} up -d`)
      return
    }

    console.log('\nStarting a2wave (docker compose up -d)...')
    // Explicit -p: a COMPOSE_PROJECT_NAME preset in the shell env would
    // otherwise override the per-install name in .env (env beats .env in
    // Compose precedence) and re-open the shared-volume hazard. Both pins come
    // from what was just written, not the environment: the generated file reads
    // the image from a variable, so an inherited one would win over the .env.
    const install: Install = { dir, projectName, image, port }
    try {
      composeExec(install, 'up -d', { stdio: 'inherit' })
    } catch {
      throw new CliError(
        `Failed to start the container. Check the output above, then retry with: cd ${shellQuote(dir)} && docker compose -p ${projectName} up -d`,
      )
    }

    console.log(`Waiting for ${localUrl}/api/health ...`)
    try {
      await waitForHealth(localUrl, timeoutSeconds, install)
    } catch (err) {
      // Do NOT touch the CLI config on failure — it may point at a working
      // instance. The container keeps starting in the background; hand the
      // user the recovery command for when it eventually comes up.
      const message = err instanceof Error ? err.message : String(err)
      throw new CliError(
        [
          message,
          '',
          `If the platform comes up later, point the CLI at it with: a2wave config set-url ${baseUrl}`,
        ].join('\n'),
      )
    }

    // Point the CLI at the new instance. Keep the login token only when the
    // URL is unchanged — a token must never be sent to a different host.
    // (A post-logout config is `{}`, not null, so normalize token explicitly.)
    const existing = loadConfig()
    const sameInstance = existing?.url === baseUrl
    saveConfig({ ...existing, url: baseUrl, token: sameInstance ? (existing?.token ?? '') : '' })

    console.log('\n✔ a2wave is up and running')
    console.log(`  Web: ${baseUrl}`)

    // Offer to set the admin password here so the install finishes in one place.
    // Requires a TTY (readSecret needs raw mode to suppress the echo) AND the
    // absence of --yes: that flag documents itself as "accept all defaults
    // without prompting", and automation that allocates a PTY (expect, ssh -t,
    // some CI runners) would otherwise block forever on a hidden prompt.
    let passwordSet = false
    if (process.stdin.isTTY && !args.yes) {
      console.log('\nSet the admin password (leave blank to skip and use the web screen):')
      passwordSet = await promptAndSetAdminPassword(localUrl)
    }

    console.log('\nNext steps:')
    if (passwordSet) {
      console.log('  1. Admin password set — sign in at the URL above as "admin".')
    } else {
      console.log(`  1. Open ${baseUrl} — the first visit asks you to set the admin password.`)
    }
    console.log('  2. Note: running Agents requires provider credentials; see the deployment docs.')
    console.log('  3. Then log the CLI in: a2wave login --password')
  },
})
