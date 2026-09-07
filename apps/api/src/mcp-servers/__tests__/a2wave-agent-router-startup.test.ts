import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the router with its internal token and no platform AUTH_SECRET or dotenv file', () => {
  const routerUrl = new URL('../a2wave-agent-router.ts', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
        delete process.env.AUTH_SECRET
        delete process.env.VITEST
        process.env.NODE_ENV = 'production'
        process.env.A2WAVE_INTERNAL_TOKEN = 'router-test-token'
        // Docker has no dotenv file; the Agent CLI strips platform credentials.
        process.loadEnvFile = () => {}
        const router = await import(${JSON.stringify(routerUrl)})
        console.log(JSON.stringify(router.parseRouteTargets(undefined)))
      `,
    ],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 10_000,
    },
  )

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('null')
})
