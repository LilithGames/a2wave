import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('scm_chown_targets', () => {
  it('emits only the a2wave-managed subtrees, never the mount root', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sources'))
    mkdirSync(join(root, 'workspaces'))

    assert.deepEqual(chownTargets(root), [join(root, 'sources'), join(root, 'workspaces')])
  })

  /**
   * DELETE parks a vacated checkout in `.reclaiming/` and the startup sweep
   * deletes it as appuser. A remap that skipped this subtree would leave those
   * directories owned by the old UID, so the sweep could never remove them —
   * a permanent leak of exactly the space reclaim exists to recover.
   */
  it('emits the reclaim isolation subtree so the startup sweep can delete it', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sources'))
    mkdirSync(join(root, '.reclaiming'))

    assert.deepEqual(chownTargets(root), [join(root, 'sources'), join(root, '.reclaiming')])
  })

  it('leaves an operator directory under the same mount untouched', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sources'))
    mkdirSync(join(root, 'workspaces'))
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
    mkdirSync(join(root, 'sources'))

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
    spawnSync('ln', ['-s', outside, join(root, 'sources')])
    mkdirSync(join(root, 'workspaces'))

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
    mkdirSync(join(real, 'sources'))
    mkdirSync(join(real, 'workspaces'))
    const link = join(makeRoot(), 'linked-root')
    spawnSync('ln', ['-s', real, link])

    assert.deepEqual(chownTargets(link), [])
  })

  it('emits nothing when the root does not exist', () => {
    assert.deepEqual(chownTargets(join(makeRoot(), 'absent')), [])
  })
})
