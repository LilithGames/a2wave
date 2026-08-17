import { execSync } from 'node:child_process'

/**
 * The running build's version.
 *
 * `APP_VERSION` is what container images set at build time; a source checkout
 * has no such env, so fall back to the tag `git describe` reports. Neither
 * available (an unpacked tarball, say) degrades to 'dev' rather than throwing —
 * callers render this string, they do not depend on it.
 */
export function getVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    return execSync('git describe --tags --always').toString().trim()
  } catch {
    return 'dev'
  }
}
