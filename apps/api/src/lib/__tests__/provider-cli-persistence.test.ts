import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const currentDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(currentDir, '../../../../..')

function readProjectFile(path: string): string {
  return readFileSync(resolve(rootDir, path), 'utf8')
}

describe('Provider CLI local-session persistence', () => {
  it('keeps the historical workspace bind mount as the root Compose default', async () => {
    const compose = readProjectFile('docker-compose.yml')

    expect(compose).toContain('${A2WAVE_WORKSPACE_DIR:-/data/workspace}:/data/workspace')
    expect(compose).not.toMatch(/\n\s+a2wave-workspace:\s*(?:\n|$)/)
  })

  it('lets root Compose allocate new Git paths from the configured SCM storage root', async () => {
    const compose = readProjectFile('docker-compose.yml')

    expect(compose).toContain('SCM_STORAGE_ROOT=${SCM_STORAGE_ROOT:-/data/workspace}')
    expect(compose).toContain('SCM_GIT_LOCAL_PATH=${SCM_GIT_LOCAL_PATH:-}')
  })

  it('runs the API with the persistent appuser HOME in Docker Compose', async () => {
    const dockerfile = readProjectFile('Dockerfile')
    const compose = readProjectFile('docker-compose.yml')

    expect(dockerfile).toMatch(/ENV HOME=\/home\/appuser/)
    expect(compose).toContain('a2wave-cli-home:/home/appuser')
    expect(compose).toContain('A2WAVE_RUN_AS_UID=${A2WAVE_RUN_AS_UID:-}')
    expect(compose).toContain('A2WAVE_RUN_AS_GID=${A2WAVE_RUN_AS_GID:-}')
    expect(compose).toMatch(/\n\s+a2wave-cli-home:\s*(?:\n|$)/)
  })

  it('keeps the unified CLI HOME across remote container replacement', async () => {
    const deployScript = readProjectFile('scripts/deploy-remote.sh')

    expect(deployScript).toContain('${DATA_DIR}/cli-home')
    expect(deployScript).toContain('${DATA_DIR}/cli-home:/home/appuser')
  })
})
