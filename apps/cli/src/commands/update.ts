import { execFileSync } from 'node:child_process'
import { defineCommand } from 'citty'
import { CliError } from '../errors.js'
import { getPackageName, getVersion } from '../version.js'

// Only an explicit override redirects the upgrade; otherwise npm's own default
// registry applies, so a mirror is configured the usual way (npm config / .npmrc).
function resolveRegistry(): string | null {
  return process.env.A2WAVE_NPM_REGISTRY?.trim() || null
}

function registryArgs(registry: string | null): string[] {
  return registry ? ['--registry', registry] : []
}

export const updateCommand = defineCommand({
  meta: {
    name: 'update',
    agentMeta: { risk: 'write' },
    description: 'Update the a2wave CLI to the latest version',
  },
  run: async () => {
    console.log('Checking for updates...')

    const registry = resolveRegistry()

    try {
      const cliPackage = getPackageName()
      if (!cliPackage) {
        throw new CliError('Update failed: could not resolve the package name from package.json.')
      }

      const latest = execFileSync(
        'npm',
        ['view', cliPackage, 'version', ...registryArgs(registry)],
        { encoding: 'utf-8' },
      ).trim()

      const current = getVersion()

      if (current === latest) {
        console.log(`Already up to date (v${current})`)
        return
      }

      console.log(`Updating v${current} → v${latest}...`)
      execFileSync('npm', ['i', '-g', `${cliPackage}@latest`, ...registryArgs(registry)], {
        stdio: 'inherit',
      })
      console.log(`\nUpdated to v${latest} ✓`)
    } catch (err) {
      if (err instanceof CliError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (/\b(?:401|403|E401|E403|Unauthorized|Forbidden)\b/i.test(msg)) {
        throw new CliError(
          [
            'Update failed: registry authentication failed (401/403).',
            `Make sure you are logged in to the npm registry (current registry: ${registry ?? 'npm default registry'}).`,
            `Original error: ${msg}`,
          ].join('\n'),
        )
      }
      throw new CliError(`Update failed: ${msg}`)
    }
  },
})
