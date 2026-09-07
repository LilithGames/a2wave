import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testDir, '..', '..', '..')
const loginScript = resolve(projectRoot, 'scripts/codex-login-remote.sh')

function writeExecutable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`)
  chmodSync(path, 0o755)
}

/**
 * The login flow walks the container through several `remote` probes before it
 * reaches the interactive `codex login`; each fake answer below keeps the script
 * on the happy path so the interactive step is actually exercised.
 */
function createFakeCommands(directory) {
  writeExecutable(
    join(directory, 'sshpass'),
    `
last="\${!#}"
printf '%s\\0' "$@" > "\${CAPTURED_SSH_ARGV:-/dev/null}"
case "$last" in
  *"State.Status"*)       printf 'running\\n' ;;
  *"range .Mounts"*)      printf '/home/appuser/.codex\\n' ;;
  *"pgrep -f"*)           printf '4242\\n' ;;
  *"NetworkSettings"*)    printf '172.17.0.2\\n' ;;
  *"codex login status"*) printf 'Logged in\\n' ;;
  *"codex login"*)        cat > "\${CAPTURED_CODEX_STDIN:-/dev/null}" ;;
  *) : ;;
esac
`,
  )
  // No stale tunnel to reap, and nothing worth waiting for.
  writeExecutable(join(directory, 'lsof'), ':')
  writeExecutable(join(directory, 'sleep'), ':')
}

function runLogin({ args = [], env = {}, input = '' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'a2wave-codex-login-test-'))
  const capturedCodexStdin = join(directory, 'codex-stdin')
  const capturedSshArgv = join(directory, 'ssh-argv')
  createFakeCommands(directory)

  const result = spawnSync('bash', [loginScript, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CAPTURED_CODEX_STDIN: capturedCodexStdin,
      CAPTURED_SSH_ARGV: capturedSshArgv,
      DEPLOY_HOST: '192.0.2.10',
      DEPLOY_USER: 'deploy',
      DEPLOY_PASS: 'test-password',
      ...env,
    },
  })

  return { result, capturedCodexStdin, capturedSshArgv }
}

function sshArgvOf(path) {
  return readFileSync(path).toString().split('\0').filter(Boolean)
}

// `codex login` runs in the foreground and keeps reading the terminal, so the
// operator has to be able to answer its prompts. The sudo password is spliced in
// front of that stdin by a background feeder, and the feeder used to be an async
// list — whose stdin is /dev/null in a non-interactive shell, so its `cat` hit
// EOF at once and the operator's keystrokes never reached the remote command.
test('the interactive login forwards operator stdin after the sudo password', () => {
  const { result, capturedCodexStdin } = runLogin({ input: 'first-answer\nsecond-answer\n' })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(
    readFileSync(capturedCodexStdin, 'utf8'),
    'test-password\nfirst-answer\nsecond-answer\n',
  )
})

test('--help prints usage without contacting the host', () => {
  const { result } = runLogin({
    args: ['--help'],
    env: { DEPLOY_HOST: '', DEPLOY_USER: '', DEPLOY_PASS: '' },
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /--container/)
})

// Shared with deploy-remote.sh through scripts/deploy/lib/ssh-opts.sh: host key
// checking is never disabled, and either pinning knob makes it strict.
test('SSH host key checking is never disabled', () => {
  const { result, capturedSshArgv } = runLogin({ args: ['--status'] })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const sshArgv = sshArgvOf(capturedSshArgv)
  assert.ok(!sshArgv.some((argument) => argument.includes('StrictHostKeyChecking=no')))
  assert.ok(sshArgv.includes('StrictHostKeyChecking=accept-new'))
})

test('a pinned known_hosts file makes host key checking strict', () => {
  const { capturedSshArgv } = runLogin({
    args: ['--status'],
    env: { DEPLOY_KNOWN_HOSTS_FILE: '/etc/a2wave/known_hosts' },
  })

  const sshArgv = sshArgvOf(capturedSshArgv)
  assert.ok(sshArgv.includes('StrictHostKeyChecking=yes'))
  assert.ok(sshArgv.includes('UserKnownHostsFile=/etc/a2wave/known_hosts'))
})

test('DEPLOY_HOST_KEY pins the key without a known_hosts file on disk', () => {
  const { capturedSshArgv } = runLogin({
    args: ['--status'],
    env: { DEPLOY_HOST_KEY: '192.0.2.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' },
  })

  const sshArgv = sshArgvOf(capturedSshArgv)
  assert.ok(sshArgv.includes('StrictHostKeyChecking=yes'))
  assert.ok(sshArgv.some((argument) => argument.startsWith('UserKnownHostsFile=')))
})

// The SSH password must not sit in the local argv either — sshpass -e reads it
// from the environment.
test('no secret reaches the local sshpass command line', () => {
  const { capturedSshArgv } = runLogin({ args: ['--status'] })

  const sshArgv = sshArgvOf(capturedSshArgv)
  assert.ok(!sshArgv.includes('-p'))
  assert.ok(!sshArgv.some((argument) => argument.includes('test-password')))
})
