import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildNpmInstallArgs,
  buildNpmSubprocessEnv,
  installProvider,
  loadAndValidateLock,
  loadSupportedProviderKinds,
  resolveArchiveTarget,
  resolveInstallLayout,
  uninstallProvider,
  verifyNpmArchiveIntegrity,
  versionOutputMatches,
} from '../install.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const lockPath = resolve(root, 'provider-cli-lock.json')
const lockSchemaPath = resolve(root, 'scripts/provider-clis/provider-cli-lock.schema.json')

test('installer derives its supported Provider kinds from the lock schema', () => {
  const schema = JSON.parse(readFileSync(lockSchemaPath, 'utf8'))
  const schemaKinds = schema.properties.providers.items.properties.kind.enum

  assert.deepEqual([...loadSupportedProviderKinds(lockSchemaPath)], schemaKinds)
})

test('lock contains one exact installation source for every built-in Provider', () => {
  const lock = loadAndValidateLock(lockPath)
  assert.deepEqual(lock.providers.map((provider) => provider.kind).sort(), [
    'claude-code',
    'codex',
    'cursor',
    'kimi',
    'opencode',
    'pi',
    'qoder',
    'trae',
  ])
  for (const provider of lock.providers) {
    assert.match(provider.version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/)
  }
})

test('archive-installed Providers are architecture-specific and checksum locked', () => {
  const lock = loadAndValidateLock(lockPath)
  for (const [kind, version] of [
    ['cursor', '2026.07.16-899851b'],
    ['trae', '0.120.42'],
  ]) {
    const provider = lock.providers.find((candidate) => candidate.kind === kind)
    assert.ok(provider)
    assert.equal(provider.install.type, 'archive')
    for (const arch of ['amd64', 'arm64']) {
      const target = resolveArchiveTarget(provider, 'linux', arch)
      assert.match(target.sha256, /^[a-f0-9]{64}$/)
      assert.match(target.url, new RegExp(version.replaceAll('.', '\\.')))
    }
  }
})

test('npm-installed Providers use their canonical package names', () => {
  const lock = loadAndValidateLock(lockPath)
  const expectedPackages = new Map([
    ['claude-code', '@anthropic-ai/claude-code'],
    ['codex', '@openai/codex'],
    ['kimi', '@moonshot-ai/kimi-code'],
    ['opencode', 'opencode-ai'],
    ['pi', '@earendil-works/pi-coding-agent'],
    ['qoder', '@qoder-ai/qodercli'],
  ])

  for (const [kind, packageName] of expectedPackages) {
    const provider = lock.providers.find((candidate) => candidate.kind === kind)
    assert.ok(provider)
    assert.equal(provider.install.type, 'npm')
    assert.equal(provider.install.package, packageName)
    assert.match(provider.install.tarball, /^https:\/\/registry\.npmjs\.org\//)
    assert.match(provider.install.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/)
    assert.equal(typeof provider.install.allowScripts, 'boolean')
  }
})

test('npm lifecycle scripts are disabled unless the lock explicitly allows them', () => {
  const lock = loadAndValidateLock(lockPath)
  const codex = lock.providers.find((provider) => provider.kind === 'codex')
  const claude = lock.providers.find((provider) => provider.kind === 'claude-code')
  assert.ok(codex)
  assert.ok(claude)

  assert.ok(buildNpmInstallArgs(codex, '/tmp/codex.tgz').includes('--ignore-scripts'))
  assert.ok(!buildNpmInstallArgs(claude, '/tmp/claude.tgz').includes('--ignore-scripts'))
})

test('npm archive verification rejects content that does not match the lock', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'a2wave-provider-npm-'))
  const archivePath = resolve(directory, 'package.tgz')
  writeFileSync(archivePath, 'tampered package')

  try {
    assert.throws(
      () => verifyNpmArchiveIntegrity('codex', archivePath, 'sha512-AAAAAAAA'),
      /npm archive integrity mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lock validation rejects unknown Provider kinds', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'a2wave-provider-lock-'))
  const invalidLockPath = resolve(directory, 'provider-cli-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.providers[0].kind = 'renamed-display-label'
  writeFileSync(invalidLockPath, JSON.stringify(lock))

  try {
    assert.throws(
      () => loadAndValidateLock(invalidLockPath),
      /unsupported Provider kind: renamed-display-label/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lock validation rejects archive targets that do not use HTTPS', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'a2wave-provider-lock-'))
  const invalidLockPath = resolve(directory, 'provider-cli-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const archiveProvider = lock.providers.find((provider) => provider.install.type === 'archive')
  assert.ok(archiveProvider)
  archiveProvider.install.targets['linux-amd64'].url = 'http://downloads.example.test/cli.tar.gz'
  writeFileSync(invalidLockPath, JSON.stringify(lock))

  try {
    assert.throws(() => loadAndValidateLock(invalidLockPath), /archive URL must use HTTPS/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('archive URL contract requires HTTPS in the lock schema', () => {
  const schema = JSON.parse(readFileSync(lockSchemaPath, 'utf8'))
  const archiveInstall = schema.properties.providers.items.properties.install.oneOf.find(
    (candidate) => candidate.properties.type.const === 'archive',
  )

  assert.equal(
    archiveInstall.properties.targets.additionalProperties.properties.url.pattern,
    '^https://',
  )
})

test('lock validation rejects a binary that would escape the install root', () => {
  // `binary` is joined onto the install root and passed to rmSync/symlinkSync, so
  // a traversing value in a hand-edited lock would delete outside the root.
  const directory = mkdtempSync(resolve(tmpdir(), 'a2wave-provider-lock-'))
  const invalidLockPath = resolve(directory, 'provider-cli-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.providers[0].binary = '../../escaped'
  writeFileSync(invalidLockPath, JSON.stringify(lock))

  try {
    assert.throws(() => loadAndValidateLock(invalidLockPath), /must not contain "\." or "\.\."/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lock validation rejects an absolute binary path', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'a2wave-provider-lock-'))
  const invalidLockPath = resolve(directory, 'provider-cli-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.providers[0].binary = '/usr/local/bin/evil'
  writeFileSync(invalidLockPath, JSON.stringify(lock))

  try {
    assert.throws(() => loadAndValidateLock(invalidLockPath), /must be relative/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('non-Provider tools are locked and validated exactly like Provider CLIs', () => {
  // CodeGraph is removed from the image with the rest, so it must be installable
  // at runtime — but it is not a Provider, so it lives in `tools` to keep the
  // Provider-kind contract (shared enum / zod / drizzle / schema) exact.
  const lock = loadAndValidateLock(lockPath)
  const codegraph = (lock.tools ?? []).find((tool) => tool.kind === 'codegraph')

  assert.ok(codegraph, 'codegraph must be a managed tool')
  assert.match(codegraph.version, /^\d+\.\d+\.\d+$/)
  assert.match(codegraph.install.tarball, /^https:\/\/registry\.npmjs\.org\//)
  assert.match(codegraph.install.integrity, /^sha512-/)
  assert.equal(codegraph.kind in Object.fromEntries(lock.providers.map((p) => [p.kind, 1])), false)
})

test('omitting an install root keeps the historical root-owned layout', () => {
  // The image build runs as root and relies on these exact paths; changing the
  // default would silently relocate every build-time install.
  const layout = resolveInstallLayout()

  assert.deepEqual(layout, {
    binDir: '/usr/local/bin',
    archiveDir: '/opt/provider-clis',
    npmRoot: '/opt/provider-clis-npm',
  })
})

test('the default npm root is installer-owned, never a system-shared prefix', () => {
  // Regression: npmRoot was once npm's own '/usr/local' prefix, and promotion
  // recursively deletes the prefix it replaces — running the installer with no
  // --install-root would have deleted Node, npm, p4, uv and the rest of
  // /usr/local. The bin symlink still lands in /usr/local/bin, so what reaches
  // PATH is unchanged; only the directory the installer may delete moved.
  const layout = resolveInstallLayout()

  assert.notEqual(layout.npmRoot, '/usr/local')
  assert.notEqual(layout.npmRoot, '/usr')
  assert.equal(layout.binDir, '/usr/local/bin', 'PATH-visible location must be unchanged')
  assert.ok(
    !'/usr/local'.startsWith(`${layout.npmRoot}/`) && layout.npmRoot !== '/usr/local',
    'the deletable npm root must not contain or equal /usr/local',
  )
})

test('an install root derives every subdirectory so callers track only one path', () => {
  const layout = resolveInstallLayout('/home/appuser/.a2wave')

  assert.deepEqual(layout, {
    npmRoot: '/home/appuser/.a2wave/npm',
    binDir: '/home/appuser/.a2wave/bin',
    archiveDir: '/home/appuser/.a2wave/opt',
  })
})

test('a relative install root is resolved to an absolute path', () => {
  // The API passes a configured directory; a relative value would otherwise
  // resolve against whatever cwd the service happens to run in.
  const layout = resolveInstallLayout('relative/cli-root')

  assert.ok(layout.binDir.startsWith('/'), `expected absolute path, got ${layout.binDir}`)
  assert.match(layout.binDir, /relative\/cli-root\/bin$/)
})

test('npm installs never point --global at the shared bin directory', () => {
  // `npm --global` writes lib/, include/, and share/ next to bin/, so each
  // prefix must be its own subtree rather than the directory holding symlinks.
  const layout = resolveInstallLayout('/home/appuser/.a2wave')

  assert.notEqual(layout.npmRoot, layout.binDir)
})

test('entrypoint caches CLI HOME ownership repair after the first successful scan', () => {
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')

  assert.match(entrypoint, /CLI_HOME_OWNER_MARKER="\/home\/appuser\/\.a2wave-home-owner"/)
  assert.match(entrypoint, /RECORDED_CLI_HOME_OWNER.*EXPECTED_CLI_HOME_OWNER/)
  assert.match(entrypoint, /printf.*EXPECTED_CLI_HOME_OWNER.*CLI_HOME_OWNER_MARKER/)
})

test('root test command includes shared and Provider installer suites', () => {
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

  assert.match(rootPackage.scripts.test, /\.\/packages\/\*/)
  assert.match(rootPackage.scripts.test, /provider-clis:test/)
  assert.match(rootPackage.scripts['test:all'], /^pnpm test &&/)
})

test('Dockerfile ships the lock and installer without preinstalling any CLI', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')

  // The installer and its lock must be present for runtime installs to reuse the
  // same pinned versions and checksum verification the build once performed.
  assert.match(dockerfile, /COPY provider-cli-lock\.json/)
  assert.match(dockerfile, /COPY scripts\/provider-clis\/install\.mjs/)
  assert.match(dockerfile, /COPY scripts\/provider-clis\/provider-cli-lock\.schema\.json/)

  // But nothing may actually install during the build — avoiding that growing
  // multi-CLI payload is why the on-demand flow exists.
  assert.doesNotMatch(dockerfile, /RUN\s+node .*install\.mjs/)
  assert.doesNotMatch(dockerfile, /npm install -g @colbymchenry\/codegraph/)
  assert.doesNotMatch(dockerfile, /npm install -g @anthropic-ai\/claude-code/)
  assert.doesNotMatch(dockerfile, /npm install -g @openai\/codex/)
  assert.doesNotMatch(dockerfile, /npm install -g opencode-ai/)
  assert.doesNotMatch(dockerfile, /npm install -g @qoder-ai\/qodercli/)
  assert.doesNotMatch(dockerfile, /npm install -g @github\/copilot/)
  assert.doesNotMatch(dockerfile, /npm install -g @earendil-works\/pi-coding-agent/)
  assert.doesNotMatch(dockerfile, /https:\/\/cursor\.com\/install/)
  assert.doesNotMatch(dockerfile, /https:\/\/trae\.cn\/trae-cli\/install\.sh/)
})

test('Dockerfile keeps the Linux dependency for Claude Code native sandboxing', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')

  assert.match(dockerfile, /apt-get install[^\n]*\bbubblewrap\b/)
})

test('Dockerfile retries the pinned Perforce download on transient network failures', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')

  assert.match(
    dockerfile,
    /curl -fsSL --retry 5 --retry-all-errors --retry-delay 2\s+\\\s+"https:\/\/filehost\.perforce\.com\/perforce\/r24\.2/,
  )
})

test('Dockerfile fetches p4 from the host the pinned checksums track', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')

  // Not a style preference: `cdist2` and `filehost` can serve different builds
  // of the same r24.2 path. On 2026-08-14 `cdist2` was still serving x86_64
  // changelist 2877946 while the published SHA256SUMS (and both arches on
  // `filehost`) had moved to 3030719, so the pinned hash failed to verify a
  // binary that was merely stale. Reverting the host silently reintroduces
  // that build break.
  assert.doesNotMatch(dockerfile, /cdist2\.perforce\.com\/perforce\/[^\n]*\/p4"/)
})

test('Dockerfile points the service at the flattened installer directory', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')

  // The image copies the installer to /app/provider-clis while a source checkout
  // keeps it at scripts/provider-clis. The service derives its default from its
  // own module path, which lands on /app — so without this explicit override it
  // would look for the lock in the wrong place and every install would fail.
  const lockDir = dockerfile.match(/ENV A2WAVE_CLI_LOCK_DIR=(\S+)/)?.[1]
  assert.equal(lockDir, '/app/provider-clis')
  assert.match(dockerfile, new RegExp(`COPY provider-cli-lock\\.json ${lockDir}/`))
  assert.match(dockerfile, new RegExp(`COPY scripts/provider-clis/install\\.mjs ${lockDir}/`))
})

test('runtime install root is on PATH for the service process only', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')

  // Engines spawn bare binary names (CLAUDE_CODE_PATH defaults to 'claude'), so
  // the install dirs must be on the *service* process's PATH. They are added by
  // the entrypoint at the privilege-drop boundary rather than in the image-global
  // PATH, which root processes outside the entrypoint (tini, healthcheck curl)
  // would otherwise resolve against.
  assert.match(entrypoint, /PATH="\$\{CLI_INSTALL_ROOT\}\/bin:/)
  // NPM_CONFIG_PREFIX is deliberately absent: each npm CLI gets its own per-kind
  // prefix, passed explicitly by the installer, so a single image-wide prefix
  // would reintroduce the shared directory that made promotion unsafe.
  assert.doesNotMatch(dockerfile, /ENV NPM_CONFIG_PREFIX=/)
})

test('entrypoint creates the install root without relying on the cached ownership scan', () => {
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')

  // The ownership-repair block below is marker-cached and skipped entirely on a
  // second boot, so these directories must chown themselves to stay writable.
  assert.match(entrypoint, /mkdir -p "\$cli_path"/)
  assert.match(entrypoint, /chown -h "\$TARGET_UID:\$TARGET_GID" "\$cli_path"/)

  // These paths live on a volume the service user can write, so root must not
  // follow a planted symlink (which would chown a target outside the volume).
  assert.match(entrypoint, /if \[ -L "\$cli_path" \]; then/)
  assert.match(entrypoint, /refusing to start: \$cli_path is a symlink/)
})

test('entrypoint owns only managed SCM subdirectories, never a host mount root', () => {
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')
  const preflight = entrypoint.indexOf('scm_prepare_managed_storage "$SCM_STORAGE_ROOT"')
  const noRemap = entrypoint.indexOf('no remap needed')
  const ownership = entrypoint.indexOf('for scm_subdir in $SCM_MANAGED_SUBDIRS; do')
  assert.ok(preflight !== -1 && preflight < noRemap, 'SCM preflight must precede UID handling')
  assert.ok(ownership > noRemap, 'SCM ownership repair must run after both UID branches')

  // The default is resolved ONCE, above the remap block, because both that block
  // and the provisioning below it read the variable. Two `${SCM_STORAGE_ROOT:-…}`
  // fallbacks is how the sweep and the provisioning would drift onto different
  // roots.
  const defaults = entrypoint.match(/SCM_STORAGE_ROOT="\$\{SCM_STORAGE_ROOT:-/g) ?? []
  assert.equal(defaults.length, 1, 'SCM_STORAGE_ROOT default must be defined exactly once')

  assert.match(entrypoint, /scm_prepare_managed_storage "\$SCM_STORAGE_ROOT"/)
  // Provisioning iterates the same list the chown sweep uses, so a subtree can
  // never be created here yet missed by the remap.
  assert.match(entrypoint, /for scm_subdir in \$SCM_MANAGED_SUBDIRS; do/)
  assert.match(entrypoint, /scm_dir="\$SCM_STORAGE_ROOT\/\$scm_subdir"/)
  assert.match(entrypoint, /chown -h "\$TARGET_UID:\$TARGET_GID" "\$scm_dir"/)
  assert.doesNotMatch(
    entrypoint,
    /chown -h "\$TARGET_UID:\$TARGET_GID" "\$SCM_STORAGE_ROOT"(?:\s|$)/,
  )
  assert.match(entrypoint, /is not an a2wave-managed SCM storage root/)
})

/**
 * The UID remap must not sweep the whole storage root. On the shipped Compose
 * defaults that root IS the /data/workspace bind mount, so a blanket
 * `find /data/workspace ... -exec chown` handed every operator-owned file under
 * it to appuser — and chowned the mount root itself, the one thing the
 * provisioning block deliberately refuses to touch.
 */
test('entrypoint UID remap sweeps only the managed SCM subtrees', () => {
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')

  assert.doesNotMatch(entrypoint, /find \/data\/workspace/)
  assert.match(entrypoint, /scm_chown_targets "\$SCM_STORAGE_ROOT"/)
  assert.match(entrypoint, /\. \/usr\/local\/bin\/entrypoint-scm-paths\.sh/)

  // The symlinked-root refusal must precede the sweep. Behind a symlink whose
  // target holds sources/ or workspaces/, sweeping first chowns real directories
  // outside the mount and only then exits 1 — too late to matter.
  const symlinkRefusal = entrypoint.indexOf('scm_prepare_managed_storage "$SCM_STORAGE_ROOT"')
  const sweep = entrypoint.indexOf('scm_chown_targets "$SCM_STORAGE_ROOT"')
  assert.ok(symlinkRefusal !== -1 && sweep !== -1)
  assert.ok(symlinkRefusal < sweep, 'symlinked-root check must run before the chown sweep')

  // The helper is sourced, so it has to be in the image.
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')
  assert.match(
    dockerfile,
    /COPY scripts\/entrypoint-scm-paths\.sh \/usr\/local\/bin\/entrypoint-scm-paths\.sh/,
  )
})

test('root Compose does not pass host ownership policy into the container', () => {
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8')

  assert.doesNotMatch(compose, /A2WAVE_MANAGED_SCM_VOLUME/)
  assert.doesNotMatch(compose, /A2WAVE_SCM_BIND_SOURCE/)
})

// ---------------------------------------------------------------------------
// Archive install atomicity
//
// installArchiveProvider used to `mkdir` the real installDir and extract into
// it directly, so a process killed mid-`tar` left a half-populated directory
// at the exact path a previous working symlink might still point through, and
// removed the old symlink before the new one existed. These tests exercise the
// real filesystem code path (a synthetic local archive stands in for `curl`,
// via the injected `exec`) rather than mocking installArchiveProvider itself,
// so a regression in the staging/rename logic actually fails them.
// ---------------------------------------------------------------------------

function buildFixtureArchive(dir, binaryContent) {
  const payloadDir = join(dir, 'payload')
  mkdirSync(payloadDir, { recursive: true })
  const binaryPath = join(payloadDir, 'fixture-cli')
  writeFileSync(binaryPath, binaryContent)
  chmodSync(binaryPath, 0o755)
  const archivePath = join(dir, 'archive.tar.gz')
  const result = spawnSync('tar', ['-czf', archivePath, '-C', payloadDir, 'fixture-cli'])
  assert.equal(result.status, 0, result.stderr?.toString())
  const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  return { archivePath, sha256 }
}

/**
 * A fake archive-type lock entry plus an `exec` that substitutes `curl` with a
 * local file copy (so the test needs no network) and runs `tar`/the version
 * probe for real, so the staging-directory and rename behaviour is exercised
 * exactly as it runs in production.
 */
function fixtureProvider(archivePath, sha256, { versionOutput = 'fixture-cli 1.0.0' } = {}) {
  return {
    kind: 'fixture',
    version: '1.0.0',
    binary: 'fixture-cli',
    versionArgs: ['--version'],
    expectedVersionOutput: '1.0.0',
    install: {
      type: 'archive',
      stripComponents: 0,
      binaryPath: 'fixture-cli',
      targets: {
        'linux-amd64': { url: 'https://example.test/fixture.tar.gz', sha256 },
      },
    },
    __fixtureArchivePath: archivePath,
    __fixtureVersionOutput: versionOutput,
  }
}

function fixtureExec(provider) {
  return async (command, args, options) => {
    if (command === 'curl') {
      const outIndex = args.indexOf('-o')
      writeFileSync(args[outIndex + 1], readFileSync(provider.__fixtureArchivePath))
      return ''
    }
    if (args[0] === '--version' && command.endsWith('fixture-cli')) {
      // Stand in for actually exec-ing the extracted binary: real fixture
      // binaries here are plain shell-less text files, not runnable, but the
      // production code path still calls exec(binaryPath, versionArgs) to
      // verify the staged tree before promoting it.
      if (!existsSync(command)) throw new Error(`fixture binary missing at ${command}`)
      return provider.__fixtureVersionOutput
    }
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: options?.capture ? 'pipe' : 'inherit',
      env: options?.env ?? process.env,
    })
    if (result.status !== 0) {
      throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ''}`)
    }
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

test('a successful archive install leaves no staging directories behind', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const { archivePath, sha256 } = buildFixtureArchive(work, 'v1-binary')
    const provider = fixtureProvider(archivePath, sha256)

    await installProvider(provider, {
      installRoot,
      targetOs: 'linux',
      targetArch: 'amd64',
      exec: fixtureExec(provider),
    })

    const versionDir = join(installRoot, 'opt', 'fixture', '1.0.0')
    assert.ok(existsSync(versionDir), 'the real install directory must exist')
    assert.ok(existsSync(join(installRoot, 'bin', 'fixture-cli')), 'symlink must exist')
    const leftovers = readdirSync(join(installRoot, 'opt', 'fixture')).filter((name) =>
      name.includes('.tmp-'),
    )
    assert.deepEqual(leftovers, [], 'no staging directory should survive a success')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a crash during tar extraction leaves the previous working install untouched', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const { archivePath, sha256 } = buildFixtureArchive(work, 'v1-binary')
    const provider = fixtureProvider(archivePath, sha256)

    await installProvider(provider, {
      installRoot,
      targetOs: 'linux',
      targetArch: 'amd64',
      exec: fixtureExec(provider),
    })
    const linkPath = join(installRoot, 'bin', 'fixture-cli')
    const before = readFileSync(join(installRoot, 'opt', 'fixture', '1.0.0', 'fixture-cli'), 'utf8')

    // Simulate the process being killed partway through `tar`: the call throws
    // after the checksum already passed, mirroring a real `tar` process dying
    // mid-extraction (SIGKILL, OOM, container restart) rather than a clean
    // upstream failure.
    let tarWasInvoked = false
    const crashingExec = async (command, args, options) => {
      if (command === 'tar') {
        tarWasInvoked = true
        throw new Error('[simulated] process killed mid-tar-extraction')
      }
      return fixtureExec(provider)(command, args, options)
    }

    await assert.rejects(
      installProvider(provider, {
        installRoot,
        targetOs: 'linux',
        targetArch: 'amd64',
        exec: crashingExec,
      }),
      /simulated.*mid-tar-extraction/,
    )
    assert.ok(tarWasInvoked, 'the crash must happen after tar actually starts')

    // The previous good install must be completely unaffected: same file
    // content, same symlink, and no half-extracted directory left around.
    const after = readFileSync(join(installRoot, 'opt', 'fixture', '1.0.0', 'fixture-cli'), 'utf8')
    assert.equal(after, before, 'the working version directory must not be touched')
    assert.ok(existsSync(linkPath), 'the working symlink must still exist')

    const entries = readdirSync(join(installRoot, 'opt', 'fixture'))
    assert.deepEqual(
      entries.filter((name) => name.includes('.tmp-')),
      [],
      'no orphaned staging directory should remain after a crash',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('the staged binary is verified before promotion, so a broken build never replaces a working one', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const goodArchive = buildFixtureArchive(join(work, 'v1'), 'v1-binary')
    const goodProvider = fixtureProvider(goodArchive.archivePath, goodArchive.sha256)
    await installProvider(goodProvider, {
      installRoot,
      targetOs: 'linux',
      targetArch: 'amd64',
      exec: fixtureExec(goodProvider),
    })

    const badArchive = buildFixtureArchive(join(work, 'v2'), 'v2-binary-but-broken')
    const badProvider = fixtureProvider(badArchive.archivePath, badArchive.sha256)
    // Version verification of the *staged* binary fails, simulating a build
    // that extracts fine but does not actually run (wrong architecture, glibc
    // mismatch, truncated binary).
    const failingVerifyExec = async (command, args, options) => {
      if (args[0] === '--version') throw new Error('exec format error')
      return fixtureExec(badProvider)(command, args, options)
    }

    await assert.rejects(
      installProvider(badProvider, {
        installRoot,
        targetOs: 'linux',
        targetArch: 'amd64',
        exec: failingVerifyExec,
      }),
      /exec format error/,
    )

    const survivingContent = readFileSync(
      join(installRoot, 'opt', 'fixture', '1.0.0', 'fixture-cli'),
      'utf8',
    )
    assert.equal(survivingContent, 'v1-binary', 'the verified-good build must remain in place')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a successful reinstall replaces the symlink atomically with no dangling gap', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const v1 = buildFixtureArchive(join(work, 'v1'), 'v1-binary')
    const p1 = fixtureProvider(v1.archivePath, v1.sha256)
    await installProvider(p1, {
      installRoot,
      targetOs: 'linux',
      targetArch: 'amd64',
      exec: fixtureExec(p1),
    })

    const v2 = buildFixtureArchive(join(work, 'v2'), 'v2-binary')
    const p2 = fixtureProvider(v2.archivePath, v2.sha256, { versionOutput: 'fixture-cli 1.0.0' })
    await installProvider(p2, {
      installRoot,
      targetOs: 'linux',
      targetArch: 'amd64',
      exec: fixtureExec(p2),
    })

    const linkPath = join(installRoot, 'bin', 'fixture-cli')
    const content = readFileSync(linkPath, 'utf8')
    assert.equal(content, 'v2-binary', 'the symlink must resolve to the latest install')

    const entries = readdirSync(join(installRoot, 'bin'))
    assert.deepEqual(
      entries.filter((name) => name.includes('.tmp-')),
      [],
      'no orphaned link-staging file should remain after a successful swap',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// npm subprocess environment isolation
//
// claude-code / opencode / qoder are locked with allowScripts:true, so their
// install and uninstall lifecycle scripts execute third-party code. Those ran
// with the API process's full environment, which holds AUTH_SECRET, SCM PATs,
// P4 passwords and SSO client secrets — verified by installing a package whose
// postinstall read all of them. Checksum-verifying the tarball proves the bytes
// match the lock; it says nothing about what those bytes then read.
// ---------------------------------------------------------------------------

test('npm subprocess env excludes service credentials', () => {
  const env = buildNpmSubprocessEnv({
    PATH: '/usr/bin',
    HOME: '/home/appuser',
    AUTH_SECRET: 'super-secret',
    SCM_GIT_PAT: 'glpat-leaked',
    SCM_P4_PASSWD: 'p4-leaked',
    A2WAVE_OIDC_CLIENT_SECRET: 'oidc-leaked',
    ANTHROPIC_API_KEY: 'sk-ant-leaked',
    QODER_PERSONAL_ACCESS_TOKEN: 'qoder-leaked',
  })

  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/appuser')
  for (const leaked of [
    'AUTH_SECRET',
    'SCM_GIT_PAT',
    'SCM_P4_PASSWD',
    'A2WAVE_OIDC_CLIENT_SECRET',
    'ANTHROPIC_API_KEY',
    'QODER_PERSONAL_ACCESS_TOKEN',
  ]) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach an npm lifecycle script`)
  }
})

test('npm subprocess env is an allowlist, so unknown variables never leak', () => {
  // A denylist would leak every variable added to the service later; anything
  // not explicitly named must be dropped.
  const env = buildNpmSubprocessEnv({
    PATH: '/usr/bin',
    SOME_FUTURE_CREDENTIAL: 'not-yet-invented',
  })

  assert.equal(env.SOME_FUTURE_CREDENTIAL, undefined)
})

test('npm subprocess env keeps the knobs installs actually need', () => {
  // Dropping these would break installs behind a corporate proxy / private CA,
  // which is a real deployment shape for this product.
  const env = buildNpmSubprocessEnv({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.corp:3128',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    NPM_CONFIG_REGISTRY: 'https://registry.corp/',
    AUTH_SECRET: 'super-secret',
  })

  assert.equal(env.HTTPS_PROXY, 'http://proxy.corp:3128')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/corp.pem')
  assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.corp/')
  assert.equal(env.AUTH_SECRET, undefined)
})

test('npm subprocess env applies explicit overrides such as the install prefix', () => {
  const env = buildNpmSubprocessEnv(
    { PATH: '/usr/bin', AUTH_SECRET: 'super-secret' },
    { NPM_CONFIG_PREFIX: '/home/appuser/.a2wave/npm' },
  )

  assert.equal(env.NPM_CONFIG_PREFIX, '/home/appuser/.a2wave/npm')
  assert.equal(env.AUTH_SECRET, undefined)
})

test('root stage of the entrypoint does not resolve commands through writable CLI dirs', () => {
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')

  // The image PATH starts with /home/appuser/.a2wave/{npm/bin,bin}, which the
  // service user can write. The entrypoint runs id/stat/chown/find/git/gosu as
  // root before dropping privileges, so it must pin a system-only PATH first —
  // otherwise a planted binary of the same name executes as root on restart
  // (reproduced: euid=0).
  const hardening = entrypoint.indexOf('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin')
  assert.ok(hardening > 0, 'root stage must pin a system-only PATH')
  assert.ok(
    hardening < entrypoint.indexOf('id -u appuser'),
    'PATH must be pinned before the first external command runs',
  )

  // The CLI dir is composed onto PATH only at the very end, and gosu is invoked
  // by absolute path so its own resolution never depends on that value.
  assert.match(entrypoint, /PATH="\$\{CLI_INSTALL_ROOT\}\/bin:/)
  assert.match(entrypoint, /exec \/usr\/sbin\/gosu appuser "\$@"/)
})

test('version matching is bounded, so a wrong major version cannot pass', () => {
  // `includes()` matched across digit boundaries: with 2.1.212 locked, a build
  // reporting 12.1.212 was accepted as a successful install.
  assert.equal(versionOutputMatches('claude 2.1.212 (build abc)', '2.1.212'), true)
  assert.equal(versionOutputMatches('codex-cli 0.144.5', '0.144.5'), true)
  assert.equal(versionOutputMatches('trae-cli version 0.120.42', '0.120.42'), true)

  assert.equal(versionOutputMatches('claude 12.1.212', '2.1.212'), false)
  assert.equal(versionOutputMatches('claude 2.1.2120', '2.1.212'), false)
})

test('version matching accepts real CLI output with trailing punctuation', () => {
  // Regression caught in a live container: Copilot prints
  // `GitHub Copilot CLI 1.0.71.` and a character-class boundary treated the
  // sentence-ending period as part of the version, rejecting a correct install.
  assert.equal(versionOutputMatches('GitHub Copilot CLI 1.0.71.', '1.0.71'), true)
  // But a genuinely longer version must still be rejected.
  assert.equal(versionOutputMatches('claude 1.0.71.5', '1.0.71'), false)
  assert.equal(versionOutputMatches('claude 1.2.1.212', '2.1.212'), false)
})

test('version matching rejects a longer alphanumeric build suffix', () => {
  // Regression: the boundary only excluded digits/dots, so an extra letter
  // suffix on a git short-SHA build id was accepted — Cursor's locked version
  // is exactly this shape (2026.07.16-899851b), and a build reporting
  // 2026.07.16-899851bad would have been recorded as a successful install.
  assert.equal(
    versionOutputMatches('cursor-agent 2026.07.16-899851bad', '2026.07.16-899851b'),
    false,
  )
  assert.equal(versionOutputMatches('cursor-agent 2026.07.16-899851b', '2026.07.16-899851b'), true)
  // A space (not a version-token character) still delimits correctly.
  assert.equal(
    versionOutputMatches('cursor-agent 2026.07.16-899851b done', '2026.07.16-899851b'),
    true,
  )
})

test('a staged binary reporting the wrong version never replaces a working install', async () => {
  // Verification used to happen only after promotion (in the API layer), so a
  // wrong build had already replaced installDir and taken over the PATH symlink
  // with nothing left to roll back to.
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-version-'))
  const installRoot = join(work, 'root')
  try {
    const v1 = buildFixtureArchive(join(work, 'v1'), 'v1-binary')
    const good = fixtureProvider(v1.archivePath, v1.sha256)
    await installProvider(good, {
      installRoot,
      targetOs: 'linux',
      targetArch: 'amd64',
      exec: fixtureExec(good),
    })

    const v2 = buildFixtureArchive(join(work, 'v2'), 'v2-binary')
    // Same lock entry (expects 1.0.0) but the binary reports a different major.
    const wrong = fixtureProvider(v2.archivePath, v2.sha256, {
      versionOutput: 'fixture-cli 11.0.0',
    })

    await assert.rejects(
      installProvider(wrong, {
        installRoot,
        targetOs: 'linux',
        targetArch: 'amd64',
        exec: fixtureExec(wrong),
      }),
      /staged binary reports/,
    )

    // The working copy must still be in place AND still be what the symlink
    // resolves to — asserting only on an error status would miss the real bug.
    assert.equal(
      readFileSync(join(installRoot, 'opt', 'fixture', '1.0.0', 'fixture-cli'), 'utf8'),
      'v1-binary',
    )
    assert.equal(readFileSync(join(installRoot, 'bin', 'fixture-cli'), 'utf8'), 'v1-binary')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('credential-bearing npm config never reaches a lifecycle script', () => {
  // The previous allowlist let the whole `npm_config_*` namespace through, which
  // carries registry auth/token/password; proxy URLs also commonly hold userinfo.
  const env = buildNpmSubprocessEnv({
    PATH: '/usr/bin',
    npm_config__auth: 'BASE64-REGISTRY-AUTH',
    npm_config__authToken: 'npm-token',
    npm_config_password: 'registry-password',
    'npm_config_//registry.npmjs.org/:_authToken': 'per-registry-token',
    NPM_CONFIG_REGISTRY: 'https://registry.corp/',
  })

  assert.equal(env.npm_config__auth, undefined)
  assert.equal(env.npm_config__authToken, undefined)
  assert.equal(env.npm_config_password, undefined)
  assert.equal(env['npm_config_//registry.npmjs.org/:_authToken'], undefined)
  // The non-credential registry override still survives.
  assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.corp/')
})

test('proxy userinfo is stripped before reaching a lifecycle script', () => {
  const env = buildNpmSubprocessEnv({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://user:proxypass@proxy.corp:3128',
    HTTP_PROXY: 'http://proxy.corp:3128',
  })

  assert.ok(!env.HTTPS_PROXY.includes('proxypass'), 'proxy password must not survive')
  assert.ok(!env.HTTPS_PROXY.includes('user'), 'proxy username must not survive')
  assert.match(env.HTTPS_PROXY, /proxy\.corp:3128/)
  // A proxy with no userinfo is passed through untouched.
  assert.equal(env.HTTP_PROXY, 'http://proxy.corp:3128')
})

test('Dockerfile keeps writable CLI dirs off the image-global PATH', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8')

  // ENTRYPOINT `tini` is resolved by the container runtime and HEALTHCHECK `curl`
  // is a separate root process every 30s — neither sees docker-entrypoint.sh's
  // local PATH edits, so both were reproduced running a planted binary at euid=0.
  assert.doesNotMatch(
    dockerfile,
    /^ENV PATH=.*\.a2wave/m,
    'the writable install dirs must not be on the image-global PATH',
  )
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini"/)
  assert.match(dockerfile, /CMD \/usr\/bin\/curl -f/)
})

test('entrypoint adds the CLI dirs only at the privilege-drop boundary', () => {
  const entrypoint = readFileSync(resolve(root, 'docker-entrypoint.sh'), 'utf8')

  const pathBuild = entrypoint.indexOf('PATH="${CLI_INSTALL_ROOT}/bin:')
  const gosu = entrypoint.indexOf('exec /usr/sbin/gosu appuser')
  assert.ok(pathBuild > 0, 'the service PATH must be composed in the entrypoint')
  assert.ok(pathBuild < gosu, 'the CLI dirs must be added immediately before dropping privileges')
  assert.ok(
    pathBuild > entrypoint.indexOf('id -u appuser'),
    'the CLI dirs must not be on PATH during the root phase',
  )
})

// ---------------------------------------------------------------------------
// npm install staging / atomicity
//
// installNpmProvider used to run `npm install --global` straight against the
// live prefix, so a wrong build (bad tarball content despite a correct
// integrity hash, or an install script producing an unexpected binary) already
// overwrote a working install by the time the post-install version probe (in
// the API layer) found out. These tests fake the npm/curl subprocess calls via
// the injected `exec` — writing directly into whatever prefix the staging code
// hands it — so the staging/promotion/rollback logic itself is exercised on
// the real filesystem without depending on the network or a real npm resolve.
// ---------------------------------------------------------------------------

function npmFixtureProvider({
  versionOutput = 'fixture-cli 1.0.0',
  kind = 'fixture-npm',
  binary = 'fixture-cli',
} = {}) {
  return {
    kind,
    version: '1.0.0',
    binary,
    versionArgs: ['--version'],
    expectedVersionOutput: '1.0.0',
    install: {
      type: 'npm',
      package: `${kind}-pkg`,
      tarball: `https://registry.npmjs.org/${kind}-pkg/-/${kind}-pkg-1.0.0.tgz`,
      // sha512 SRI of the fixed 'fixture-tarball-bytes' the fixture curl writes.
      integrity:
        'sha512-Gmt9YGL3PvnnFk/LEzogfLKnGI9Tfe99eexUYaGEj4SFR/JJQ9SLTLvxtu/kBDW30IOipc92vnNgDNBmbV4jEQ==',
      allowScripts: false,
    },
    __fixtureVersionOutput: versionOutput,
  }
}

/**
 * Fake `curl`/`npm install`/`--version` for the npm path. `npm install
 * --global` is faked by writing a `bin/<name>` file directly into whatever
 * `NPM_CONFIG_PREFIX` the real code passed — the same directory real npm would
 * have used — so the staging/rename logic around it is exercised unmodified.
 */
function npmFixtureExec(provider) {
  return async (command, args, options) => {
    if (command === 'curl') {
      // installNpmProvider always verifies integrity against the lock's
      // integrity field next; give it deterministic bytes so that step is a
      // no-op for these tests (they aren't testing integrity verification).
      const outIndex = args.indexOf('-o')
      writeFileSync(args[outIndex + 1], 'fixture-tarball-bytes')
      return ''
    }
    if (command === 'npm') {
      const prefix = options?.env?.NPM_CONFIG_PREFIX
      assert.ok(prefix, 'npm must always be called with an explicit NPM_CONFIG_PREFIX')
      const binDir = join(prefix, 'bin')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, provider.binary), provider.__fixtureVersionOutput)
      return ''
    }
    if (args?.[0] === '--version' && command.endsWith(provider.binary)) {
      if (!existsSync(command)) throw new Error(`fixture binary missing at ${command}`)
      return readFileSync(command, 'utf8')
    }
    throw new Error(`unexpected exec in npm fixture: ${command} ${JSON.stringify(args)}`)
  }
}

test('a successful npm install leaves no staging prefix behind', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const provider = npmFixtureProvider()

    await installProvider(provider, { installRoot, exec: npmFixtureExec(provider) })

    assert.ok(
      existsSync(join(installRoot, 'bin', 'fixture-cli')),
      'the PATH-visible symlink must exist',
    )
    assert.ok(
      existsSync(join(installRoot, 'npm', 'fixture-npm', 'bin', 'fixture-cli')),
      'the per-kind prefix must hold the real binary',
    )
    const leftovers = readdirSync(installRoot).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'no staging prefix should survive a success')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('an npm install reporting the wrong version never replaces a working prefix', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const good = npmFixtureProvider({ versionOutput: 'fixture-cli 1.0.0' })
    await installProvider(good, { installRoot, exec: npmFixtureExec(good) })
    const binaryPath = join(installRoot, 'bin', 'fixture-cli')
    const before = readFileSync(binaryPath, 'utf8')
    assert.equal(before, 'fixture-cli 1.0.0')

    // Simulates a poisoned/retagged registry entry: the tarball installs fine
    // (correct integrity, script exits 0) but the binary it produces reports a
    // version that does not match what the lock expects.
    const wrong = npmFixtureProvider({ versionOutput: 'fixture-cli 9.9.9' })

    await assert.rejects(
      installProvider(wrong, { installRoot, exec: npmFixtureExec(wrong) }),
      /staged npm install reports/,
    )

    // The previous good install must be completely unaffected.
    assert.equal(readFileSync(binaryPath, 'utf8'), before)
    const leftovers = readdirSync(installRoot).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(
      leftovers,
      [],
      'no orphaned staging prefix should remain after a rejected install',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a crash during npm install leaves the previous working prefix untouched', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const good = npmFixtureProvider()
    await installProvider(good, { installRoot, exec: npmFixtureExec(good) })
    const binaryPath = join(installRoot, 'bin', 'fixture-cli')
    const before = readFileSync(binaryPath, 'utf8')

    let npmWasInvoked = false
    const crashingExec = async (command, args, options) => {
      if (command === 'npm') {
        npmWasInvoked = true
        throw new Error('[simulated] npm process killed mid-install')
      }
      return npmFixtureExec(good)(command, args, options)
    }

    await assert.rejects(
      installProvider(good, { installRoot, exec: crashingExec }),
      /simulated.*mid-install/,
    )
    assert.ok(npmWasInvoked, 'the crash must happen after npm actually starts')

    assert.equal(readFileSync(binaryPath, 'utf8'), before, 'the working prefix must not be touched')
    const leftovers = readdirSync(installRoot).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'no orphaned staging prefix should remain after a crash')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a successful npm reinstall replaces the prefix atomically', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-atomic-'))
  const installRoot = join(work, 'root')
  try {
    const v1 = npmFixtureProvider({ versionOutput: 'fixture-cli 1.0.0 (v1)' })
    await installProvider(v1, { installRoot, exec: npmFixtureExec(v1) })

    const v2 = npmFixtureProvider({ versionOutput: 'fixture-cli 1.0.0 (v2)' })
    await installProvider(v2, { installRoot, exec: npmFixtureExec(v2) })

    const binaryPath = join(installRoot, 'bin', 'fixture-cli')
    assert.equal(readFileSync(binaryPath, 'utf8'), 'fixture-cli 1.0.0 (v2)')
    const leftovers = readdirSync(installRoot).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(
      leftovers,
      [],
      'no orphaned staging prefix should remain after a successful swap',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('two different npm CLIs coexist after sequential installs', async () => {
  // Regression (reproduced before the fix as
  // {"afterA":true,"afterB":{"cliA":false,"cliB":true}}): every npm CLI shared
  // one prefix, and promotion replaced that whole prefix with a staging dir
  // containing only the CLI just installed — so installing the second one
  // deleted the first. Per-kind prefixes make the promoted directory genuinely
  // owned by a single package.
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-multi-'))
  const installRoot = join(work, 'root')
  try {
    const a = npmFixtureProvider({ kind: 'cli-a', binary: 'cliA', versionOutput: 'cliA 1.0.0' })
    const b = npmFixtureProvider({ kind: 'cli-b', binary: 'cliB', versionOutput: 'cliB 1.0.0' })

    await installProvider(a, { installRoot, exec: npmFixtureExec(a) })
    assert.ok(existsSync(join(installRoot, 'bin', 'cliA')), 'first CLI must install')

    await installProvider(b, { installRoot, exec: npmFixtureExec(b) })

    assert.ok(existsSync(join(installRoot, 'bin', 'cliA')), 'first CLI must survive the second')
    assert.ok(existsSync(join(installRoot, 'bin', 'cliB')), 'second CLI must install')
    // Each symlink must resolve to its own binary, not the other CLI's.
    assert.match(readFileSync(join(installRoot, 'bin', 'cliA'), 'utf8'), /cliA/)
    assert.match(readFileSync(join(installRoot, 'bin', 'cliB'), 'utf8'), /cliB/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('two different npm CLIs coexist after concurrent installs', async () => {
  // The API locks per kind, so two different npm kinds genuinely install at the
  // same time. With a shared prefix both reported success and only the last
  // promotion survived; per-kind prefixes make the two installs independent.
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-multi-'))
  const installRoot = join(work, 'root')
  try {
    const a = npmFixtureProvider({ kind: 'cli-a', binary: 'cliA', versionOutput: 'cliA 1.0.0' })
    const b = npmFixtureProvider({ kind: 'cli-b', binary: 'cliB', versionOutput: 'cliB 1.0.0' })

    await Promise.all([
      installProvider(a, { installRoot, exec: npmFixtureExec(a) }),
      installProvider(b, { installRoot, exec: npmFixtureExec(b) }),
    ])

    assert.ok(
      existsSync(join(installRoot, 'bin', 'cliA')),
      'cliA must survive a concurrent install',
    )
    assert.ok(
      existsSync(join(installRoot, 'bin', 'cliB')),
      'cliB must survive a concurrent install',
    )
    assert.match(readFileSync(join(installRoot, 'bin', 'cliA'), 'utf8'), /cliA/)
    assert.match(readFileSync(join(installRoot, 'bin', 'cliB'), 'utf8'), /cliB/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('uninstalling one npm CLI leaves the others installed', async () => {
  const work = mkdtempSync(resolve(tmpdir(), 'a2wave-npm-multi-'))
  const installRoot = join(work, 'root')
  try {
    const a = npmFixtureProvider({ kind: 'cli-a', binary: 'cliA', versionOutput: 'cliA 1.0.0' })
    const b = npmFixtureProvider({ kind: 'cli-b', binary: 'cliB', versionOutput: 'cliB 1.0.0' })
    await installProvider(a, { installRoot, exec: npmFixtureExec(a) })
    await installProvider(b, { installRoot, exec: npmFixtureExec(b) })

    await uninstallProvider(a, { installRoot })

    assert.ok(!existsSync(join(installRoot, 'bin', 'cliA')), 'the uninstalled CLI must be gone')
    assert.ok(existsSync(join(installRoot, 'bin', 'cliB')), 'the other CLI must remain')
    assert.ok(existsSync(join(installRoot, 'npm', 'cli-b')), "the other CLI's prefix must remain")
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
