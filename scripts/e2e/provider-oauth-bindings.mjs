#!/usr/bin/env node
/**
 * Real HTTP + SQLite regression for shared ChatGPT account bindings.
 * Run after pnpm install and pnpm --filter @a2wave/shared build:
 *   node scripts/e2e/provider-oauth-bindings.mjs
 *
 * Starts only the API, on a random loopback port, with a temporary HOME and DB.
 * Credentials are deliberately unusable fixtures; OAuth and inference are never
 * invoked. The child cannot load local .env files or make outgoing fetch calls.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const apiRoot = join(root, 'apps/api')
const require = createRequire(join(apiRoot, 'package.json'))
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')
const sandbox = mkdtempSync(join(tmpdir(), 'a2wave-oauth-bindings-'))
const logPath = join(sandbox, 'api.log')
const dbPath = join(sandbox, 'a2wave.db')
const accountIds = ['poa_e2e_first', 'poa_e2e_second']
let child
let database
let token
let baseUrl
let checks = 0
let cleanupTask

function check(label, callback) {
  callback()
  checks++
  console.log(`[oauth-bindings] PASS ${label}`)
}

async function request(path, { method = 'GET', body, status = 200, raw = false } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`)
  return raw ? response : response.json()
}

async function startApi() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  baseUrl = `http://127.0.0.1:${port}`
  const home = join(sandbox, 'home')
  mkdirSync(home)
  symlinkSync(join(apiRoot, 'drizzle'), join(sandbox, 'drizzle'), 'dir')
  const preloader = join(sandbox, 'isolation.mjs')
  writeFileSync(
    preloader,
    `process.loadEnvFile = () => {};
globalThis.fetch = async () => {
  console.error('E2E_UNEXPECTED_OUTBOUND_FETCH');
  throw new Error('This binding-only test must not call external services');
};\n`,
  )
  const output = openSync(logPath, 'w')
  try {
    child = spawn(
      process.execPath,
      ['--import', preloader, '--import', require.resolve('tsx'), join(apiRoot, 'src/index.ts')],
      {
        cwd: sandbox,
        detached: process.platform !== 'win32',
        stdio: ['ignore', output, output],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          NODE_ENV: 'test',
          E2E_STRICT_AUTH: '1',
          AUTH_SECRET: randomBytes(32).toString('hex'),
          DATABASE_URL: dbPath,
          HOST: '127.0.0.1',
          PORT: String(port),
          A2WAVE_DB_BACKUP_SKIP: 'true',
        },
      },
    )
  } finally {
    closeSync(output)
  }
  child.on('error', (error) => console.error(`[oauth-bindings] API process: ${error.message}`))
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited with ${child.exitCode}`)
    try {
      const health = await fetch(`${baseUrl}/api/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (health.ok) return
    } catch {
      // The server has not finished migrating and bootstrapping yet.
    }
    await delay(300)
  }
  throw new Error('API readiness timed out')
}

function assertNoAccountReferences(agent) {
  assert.ok(!agent.providerOauthAccountId)
  for (const binding of agent.config?.providerChain ?? []) {
    assert.ok(!binding.providerOauthAccountId)
  }
}

async function main() {
  await startApi()
  const password = `E2e-${randomBytes(12).toString('hex')}!`
  const setup = await request('/auth/setup', {
    method: 'POST',
    body: { password, confirmPassword: password },
  })
  token = setup.data.token
  const providers = (await request('/providers')).data
  const codex = providers.find((provider) => provider.kind === 'codex')
  assert.ok(codex, 'The Codex preset must be seeded before readiness')
  database = new Database(dbPath)
  const seed = database.prepare(`INSERT INTO provider_oauth_accounts
    (id, provider_id, label, subject, client_id, host_id, created_by_user_id,
     tokens_enc, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'e2e-client', 'e2e-host', ?,
      'unusable-e2e-fixture', unixepoch() + 3600, unixepoch(), unixepoch())`)
  for (const id of accountIds) seed.run(id, codex.id, id, id, setup.data.user.id)
  const accounts = (await request(`/providers/${codex.id}/oauth-accounts`)).data
  check('multiple shared accounts are listed without credentials', () => {
    assert.deepEqual(accounts.map((account) => account.id).sort(), [...accountIds].sort())
    assert.ok(accounts.every((account) => account.status === 'ready'))
    assert.ok(!JSON.stringify(accounts).includes('unusable-e2e-fixture'))
  })

  const top = (
    await request('/agents', {
      method: 'POST',
      status: 201,
      body: {
        name: 'OAuth top-level fixture',
        type: 'cursor',
        providerId: codex.id,
        authMode: 'oauth',
        providerOauthAccountId: accountIds[0],
      },
    })
  ).data
  check('top-level OAuth Agent create persists the account', () => {
    assert.equal(top.providerOauthAccountId, accountIds[0])
  })
  await request(`/agents/${top.id}`, {
    method: 'PATCH',
    body: { providerOauthAccountId: accountIds[1] },
  })
  const updatedTop = (await request(`/agents/${top.id}`)).data
  check('top-level account update and read complete without a SQLite lock deadlock', () => {
    assert.equal(updatedTop.providerOauthAccountId, accountIds[1])
  })
  const blockedTopDelete = await request(`/providers/${codex.id}/oauth-accounts/${accountIds[1]}`, {
    method: 'DELETE',
    status: 409,
  })
  check('deleting a top-level referenced account is rejected before revocation', () => {
    assert.equal(blockedTopDelete.code, 'account_in_use')
  })
  const topClone = (await request(`/agents/${top.id}/clone`, { method: 'POST', status: 201 })).data
  check('clone clears top-level account references', () => assertNoAccountReferences(topClone))
  await request(`/agents/${top.id}`, {
    method: 'PATCH',
    body: { authMode: 'apiKey', providerApiKey: 'e2e-unusable-api-key' },
  })
  const detachedTop = (await request(`/agents/${top.id}`)).data
  check('switching to API key authentication automatically clears the top-level account', () => {
    assert.equal(detachedTop.authMode, 'apiKey')
    assertNoAccountReferences(detachedTop)
  })

  const chain = accountIds.map((id, index) => ({
    id: `binding-${index}`,
    providerId: codex.id,
    authMode: 'oauth',
    providerOauthAccountId: id,
    enabled: true,
  }))
  const chainAgent = (
    await request('/agents', {
      method: 'POST',
      status: 201,
      body: { name: 'OAuth chain fixture', type: 'cursor', config: { providerChain: chain } },
    })
  ).data
  check('provider chain persists two independent OAuth accounts', () => {
    assert.deepEqual(
      chainAgent.config.providerChain.map((binding) => binding.providerOauthAccountId),
      accountIds,
    )
  })
  const reversedChain = [...chain].reverse()
  await request(`/agents/${chainAgent.id}`, {
    method: 'PATCH',
    body: { config: { providerChain: reversedChain } },
  })
  const updatedChain = (await request(`/agents/${chainAgent.id}`)).data
  check('provider chain update and read complete without a SQLite lock deadlock', () => {
    assert.deepEqual(
      updatedChain.config.providerChain.map((binding) => binding.providerOauthAccountId),
      [...accountIds].reverse(),
    )
  })
  const blockedChainDelete = await request(
    `/providers/${codex.id}/oauth-accounts/${accountIds[0]}`,
    { method: 'DELETE', status: 409 },
  )
  check('deleting a chain-only referenced account is rejected before revocation', () => {
    assert.equal(blockedChainDelete.code, 'account_in_use')
  })
  const chainClone = (
    await request(`/agents/${chainAgent.id}/clone`, { method: 'POST', status: 201 })
  ).data
  check('clone clears account references in every chain entry', () => {
    assertNoAccountReferences(chainClone)
  })

  const exported = await request(`/agents/${chainAgent.id}/export`, { raw: true })
  const zip = new AdmZip(Buffer.from(await exported.arrayBuffer()))
  const portableAgent = JSON.parse(zip.readAsText('agent.json'))
  check('export clears provider-chain account references', () => {
    assertNoAccountReferences(portableAgent)
  })
  // Import must discard references even when an old or hand-edited archive has
  // them; testing only our sanitized export would not exercise this boundary.
  portableAgent.providerOauthAccountId = accountIds[0]
  portableAgent.authMode = 'oauth'
  portableAgent.providerRef = codex.name
  for (const [index, binding] of portableAgent.config.providerChain.entries()) {
    binding.providerOauthAccountId = accountIds[index]
  }
  zip.updateFile('agent.json', Buffer.from(JSON.stringify(portableAgent)))
  const form = new FormData()
  form.set('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'agent.zip')
  const imported = (await request('/agents/import', { method: 'POST', body: form, status: 201 }))
    .data
  const importedAgent = (await request(`/agents/${imported.agent.id}`)).data
  check('import strips top-level and chain account references from a supplied archive', () => {
    assertNoAccountReferences(importedAgent)
    assert.ok(imported.warnings.some((warning) => warning.includes('account bindings')))
  })

  await request(`/agents/${chainAgent.id}`, {
    method: 'PATCH',
    body: {
      config: {
        providerChain: chain.map((binding) => ({
          ...binding,
          authMode: 'apiKey',
          providerOauthAccountId: null,
          providerApiKey: 'e2e-unusable-api-key',
        })),
      },
    },
  })
  const detachedChain = (await request(`/agents/${chainAgent.id}`)).data
  check('provider chain can switch to API keys and detach all account references', () => {
    assertNoAccountReferences(detachedChain)
    assert.ok(detachedChain.config.providerChain.every((binding) => binding.authMode === 'apiKey'))
  })
  check('all fixtures remain local and no external OAuth request was attempted', () => {
    assert.equal(database.prepare('SELECT count(*) AS n FROM provider_oauth_accounts').get().n, 2)
    assert.ok(!readFileSync(logPath, 'utf8').includes('E2E_UNEXPECTED_OUTBOUND_FETCH'))
  })
  console.log(`[oauth-bindings] ${checks} checks passed (real HTTP, temporary SQLite)`)
}

function cleanup() {
  cleanupTask ??= (async () => {
    database?.close()
    if (child?.pid) {
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM')
      } catch {
        // The child may already have exited after startup failure.
      }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([once(child, 'exit'), delay(2_000)])
      }
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
      } catch {
        // No process from this test remains.
      }
    }
    rmSync(sandbox, { recursive: true, force: true })
  })()
  return cleanupTask
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code))
  })
}

try {
  await main()
} catch (error) {
  console.error(`[oauth-bindings] FAIL ${error instanceof Error ? error.message : String(error)}`)
  try {
    console.error(readFileSync(logPath, 'utf8').split('\n').slice(-50).join('\n'))
  } catch {
    // The API may not have reached process startup.
  }
  process.exitCode = 1
} finally {
  await cleanup()
}
