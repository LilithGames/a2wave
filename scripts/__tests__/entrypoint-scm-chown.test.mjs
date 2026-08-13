import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

/**
 * The UID-remap branch must take ownership of the directories a2wave itself
 * wrote — and nothing else.
 *
 * It used to sweep the whole `/data/workspace` bind mount with
 * `find ... -not -uid $TARGET_UID -exec chown`. On the shipped Compose defaults
 * that mount IS `SCM_STORAGE_ROOT`, so it is routinely a host directory the
 * operator also uses directly. Any file there owned by a third UID — a
 * colleague's checkout on a shared box, a root-owned tool cache, anything
 * restored from a backup under its original owner — was silently handed to
 * appuser. The mount root itself was chowned too, which is precisely what the
 * `SCM_STORAGE_ROOT` block further down the entrypoint refuses to do.
 *
 * The fix narrows the sweep to the two subtrees a2wave allocates (`sources/`,
 * `workspaces/`), leaving every other path under the mount untouched.
 *
 * These tests exercise `scm_chown_targets`, the helper the entrypoint sources,
 * because the chown itself needs root and a real UID remap. The helper decides
 * WHAT gets swept; that decision is the whole of the bug.
 */

const SCRIPT = join(import.meta.dirname, '..', 'entrypoint-scm-paths.sh')
const dirs = []

/**
 * The reclaim directory name, read from the TypeScript that actually creates it
 * rather than restated here.
 *
 * Restating it is the bug this guards: the shell and the TS each carried their
 * own copy of `.reclaiming`, the TS side was renamed to
 * `.a2wave-scm-reclaim-v1`, and the shell kept provisioning and chowning a name
 * nothing else used. Both this test and the entrypoint stayed green while the
 * real directory was never handed to appuser — and since the entrypoint
 * deliberately leaves SCM_STORAGE_ROOT root-owned, appuser could not create it
 * at runtime either, so every source deletion failed with a 503.
 */
function reclaimDirFromSource() {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'api', 'src', 'lib', 'scm-storage.ts'),
    'utf8',
  )
  const match = source.match(/export const SCM_RECLAIM_DIR = '([^']+)'/)
  assert.ok(match, 'SCM_RECLAIM_DIR not found in apps/api/src/lib/scm-storage.ts')
  return match[1]
}

const RECLAIM_DIR = reclaimDirFromSource()
const RECLAIM_MARKER = '.a2wave-owned-reclaim-root'
const STORAGE_MARKER = '.a2wave-owned-storage-root'

/** The reclaim subtree name the shell helper declares. */
function reclaimSubdirFromScript() {
  const result = spawnSync(
    'bash',
    ['-c', `set -eu; . "$1"; printf '%s\\n' "$SCM_RECLAIM_SUBDIR"`, '_', SCRIPT],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `helper failed: ${result.stderr}`)
  return result.stdout.trim()
}

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'a2wave-scm-chown-'))
  dirs.push(dir)
  return dir
}

/** Run `scm_chown_targets <storage_root>` and return the emitted paths. */
function chownTargets(storageRoot) {
  const result = spawnSync(
    'bash',
    ['-c', `set -eu; . "$1"; scm_chown_targets "$2"`, '_', SCRIPT, storageRoot],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `helper failed: ${result.stderr}`)
  return result.stdout.split('\n').filter(Boolean)
}

/** Run the same reclaim-root provisioning helper the entrypoint calls. */
function prepareReclaimRoot(storageRoot, prelude = '') {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -eu; . "$1"; ${prelude ? `${prelude}; ` : ''}scm_prepare_reclaim_root "$2"`,
      '_',
      SCRIPT,
      storageRoot,
    ],
    { encoding: 'utf8' },
  )
}

/** Claim an otherwise unused mount for a2wave's managed child directories. */
function prepareManagedStorage(storageRoot, managedVolume = false) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -eu; . "$1"; scm_prepare_managed_storage "$2" "$3"`,
      '_',
      SCRIPT,
      storageRoot,
      String(managedVolume),
    ],
    { encoding: 'utf8' },
  )
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('scm_chown_targets', () => {
  it('marks a fresh mount before creating managed child directories', () => {
    const root = makeRoot()

    const result = prepareManagedStorage(root)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(root, STORAGE_MARKER), 'utf8'), 'a2wave-scm-storage-v1\n')
    assert.deepEqual(chownTargets(root), [join(root, 'sources'), join(root, 'workspaces')])
  })

  it('refuses to adopt a pre-existing operator sources directory', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sources'))
    writeFileSync(join(root, 'sources', 'operator-repo'), 'keep exactly')

    const result = prepareManagedStorage(root)

    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(join(root, 'sources', 'operator-repo'), 'utf8'), 'keep exactly')
    assert.throws(() => readFileSync(join(root, STORAGE_MARKER), 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(chownTargets(root), [])
  })

  it('upgrades the legacy layout only when Compose identifies its managed volume', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sources'))
    mkdirSync(join(root, 'sources', 'existing-checkout'))
    writeFileSync(join(root, 'sources', 'existing-checkout', 'README.md'), 'preserve')
    mkdirSync(join(root, 'workspaces'))

    const result = prepareManagedStorage(root, true)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(root, STORAGE_MARKER), 'utf8'), 'a2wave-scm-storage-v1\n')
    assert.equal(
      readFileSync(join(root, 'sources', 'existing-checkout', 'README.md'), 'utf8'),
      'preserve',
    )
  })

  it('creates and marks a fresh reclaim root before handing it to appuser', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    const result = prepareReclaimRoot(root)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      readFileSync(join(root, RECLAIM_DIR, RECLAIM_MARKER), 'utf8'),
      'a2wave-scm-reclaim-v1\n',
    )
    assert.deepEqual(chownTargets(root), [
      join(root, 'sources'),
      join(root, 'workspaces'),
      join(root, RECLAIM_DIR),
    ])
  })

  it('recovers an empty reclaim root left by a crash before marker creation', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    const reclaimRoot = join(root, RECLAIM_DIR)
    mkdirSync(reclaimRoot)

    const result = prepareReclaimRoot(root)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(reclaimRoot, RECLAIM_MARKER), 'utf8'), 'a2wave-scm-reclaim-v1\n')
  })

  it('refuses to adopt an unmarked reclaim root when its directory scan fails', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    const reclaimRoot = join(root, RECLAIM_DIR)
    mkdirSync(reclaimRoot)

    const result = prepareReclaimRoot(root, 'find() { return 74; }')

    assert.notEqual(result.status, 0)
    assert.throws(() => readFileSync(join(reclaimRoot, RECLAIM_MARKER), 'utf8'), { code: 'ENOENT' })
  })

  it('refuses an unmarked existing reclaim root without mutating its contents', () => {
    const root = makeRoot()
    const reclaimRoot = join(root, RECLAIM_DIR)
    mkdirSync(reclaimRoot)
    writeFileSync(join(reclaimRoot, 'operator-data'), 'keep exactly')

    const result = prepareReclaimRoot(root)

    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(join(reclaimRoot, 'operator-data'), 'utf8'), 'keep exactly')
    assert.throws(() => readFileSync(join(reclaimRoot, RECLAIM_MARKER), 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(chownTargets(root), [])
  })

  it('emits only the a2wave-managed subtrees, never the mount root', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)

    assert.deepEqual(chownTargets(root), [join(root, 'sources'), join(root, 'workspaces')])
  })

  /**
   * DELETE parks a vacated checkout in the reclaim root and the startup sweep
   * deletes it as appuser. A remap that skipped this subtree would leave those
   * directories owned by the old UID, so the sweep could never remove them —
   * a permanent leak of exactly the space reclaim exists to recover.
   *
   * The name comes from the TS that creates it, so a rename on either side
   * fails here instead of silently going unswept.
   */
  it('emits the reclaim isolation subtree so the startup sweep can delete it', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    assert.equal(prepareReclaimRoot(root).status, 0)

    assert.deepEqual(chownTargets(root), [
      join(root, 'sources'),
      join(root, 'workspaces'),
      join(root, RECLAIM_DIR),
    ])
  })

  it('never adopts an unmarked pre-existing reclaim directory as a chown target', () => {
    const root = makeRoot()
    const reclaimRoot = join(root, RECLAIM_DIR)
    mkdirSync(reclaimRoot)
    writeFileSync(join(reclaimRoot, 'operator-data'), 'keep')

    assert.deepEqual(chownTargets(root), [])
  })

  it('never adopts a reclaim directory carrying an invalid ownership marker', () => {
    const root = makeRoot()
    const reclaimRoot = join(root, RECLAIM_DIR)
    mkdirSync(reclaimRoot)
    writeFileSync(join(reclaimRoot, RECLAIM_MARKER), 'operator marker\n')

    assert.deepEqual(chownTargets(root), [])
  })

  /**
   * The shell list and the TypeScript constant must name the same directory.
   *
   * Asserted directly rather than only through behaviour because the two live
   * in different languages with no compiler between them: `19ba649` renamed the
   * TS side and left the shell on the old `.reclaiming`, and every existing
   * test still passed because they all restated the stale literal too.
   */
  it('declares the same reclaim directory the API creates', () => {
    assert.equal(
      reclaimSubdirFromScript(),
      RECLAIM_DIR,
      `SCM_RECLAIM_SUBDIR must equal ${RECLAIM_DIR} (from SCM_RECLAIM_DIR)`,
    )
  })

  it('leaves an operator directory under the same mount untouched', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    // The exact shape that broke: the operator's own work beside a2wave's data.
    mkdirSync(join(root, 'my-own-repo'))
    writeFileSync(join(root, 'notes.txt'), 'operator file')

    const targets = chownTargets(root)
    assert.ok(!targets.some((path) => path.includes('my-own-repo')))
    assert.ok(!targets.some((path) => path.includes('notes.txt')))
    assert.ok(!targets.includes(root))
  })

  it('skips a managed subtree that does not exist yet', () => {
    const root = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    rmSync(join(root, 'workspaces'), { recursive: true })

    assert.deepEqual(chownTargets(root), [join(root, 'sources')])
  })

  it('emits nothing when neither managed subtree exists', () => {
    assert.deepEqual(chownTargets(makeRoot()), [])
  })

  /**
   * appuser can write inside the persisted volume, so a symlinked subtree must
   * not become a chown target: root following it would hand ownership of the
   * link's target — potentially outside the mount — to appuser.
   */
  it('refuses a symlinked managed subtree', () => {
    const root = makeRoot()
    const outside = makeRoot()
    assert.equal(prepareManagedStorage(root).status, 0)
    rmSync(join(root, 'sources'), { recursive: true })
    spawnSync('ln', ['-s', outside, join(root, 'sources')])

    assert.deepEqual(chownTargets(root), [join(root, 'workspaces')])
  })

  /**
   * A symlinked ROOT is the same escape one level up. The entrypoint does refuse
   * to start on it, but that check used to run *after* the UID remap — so if the
   * link's target happened to contain `sources/` or `workspaces/`, the sweep
   * chowned those real directories outside the mount and only then exited 1. The
   * damage was already done.
   */
  it('emits nothing for a symlinked storage root', () => {
    const real = makeRoot()
    assert.equal(prepareManagedStorage(real).status, 0)
    const link = join(makeRoot(), 'linked-root')
    spawnSync('ln', ['-s', real, link])

    assert.deepEqual(chownTargets(link), [])
  })

  it('emits nothing when the root does not exist', () => {
    assert.deepEqual(chownTargets(join(makeRoot(), 'absent')), [])
  })
})
