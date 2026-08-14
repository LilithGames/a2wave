/**
 * Every `high-risk-write` leaf must actually be gated.
 *
 * The label was added first and four commands were found to have no gate at
 * all: `kb delete`, `mcp delete`, `scm delete` and `agents artifacts delete`
 * each issued the DELETE immediately, so an agent with no TTY destroyed the
 * record on the first call. The label is only worth carrying if it is enforced,
 * so this test runs each of them without a TTY and requires the confirmation
 * error rather than a request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'
import { agentsCommand } from '../agents.js'
import { kbCommand } from '../kb.js'
import { mcpCommand } from '../mcp.js'
import { scmCommand } from '../scm.js'

const del = vi.fn()
const resolve = vi.fn(async (v: string) => v)

vi.mock('../../client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createClient: () => ({
    del,
    get: vi.fn(),
    post: vi.fn(),
    resolveKbDocumentId: resolve,
    resolveMcpServerId: resolve,
    resolveScmSourceId: resolve,
    resolveAgentId: resolve,
  }),
}))

const originalIsTTY = process.stdin.isTTY

type Node = { subCommands?: Record<string, Node>; run?: (ctx: { args: unknown }) => Promise<void> }

function sub(root: unknown, path: string): Node {
  let node = root as Node
  for (const seg of path.split(' ')) {
    node = (node.subCommands as Record<string, Node>)[seg]
  }
  return node
}

beforeEach(() => {
  del.mockReset()
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
})

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
})

describe('high-risk deletes refuse to run unattended', () => {
  it.each([
    ['kb delete', kbCommand, 'delete', { id: 'kbd_1' }],
    ['mcp delete', mcpCommand, 'delete', { id: 'mcp_1' }],
    ['scm delete', scmCommand, 'delete', { id: 'scm_1' }],
    ['agents artifacts delete', agentsCommand, 'artifacts delete', { id: 'art_1' }],
  ])('%s throws instead of deleting', async (_label, root, path, args) => {
    const node = sub(root, path)

    const err = await (node.run as (c: { args: unknown }) => Promise<void>)({ args }).catch(
      (e) => e,
    )

    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).type).toBe('confirmation')
    expect(del).not.toHaveBeenCalled()
  })

  it.each([
    ['kb delete', kbCommand, 'delete', { id: 'kbd_1', force: true }],
    ['mcp delete', mcpCommand, 'delete', { id: 'mcp_1', force: true }],
    ['scm delete', scmCommand, 'delete', { id: 'scm_1', force: true }],
    ['agents artifacts delete', agentsCommand, 'artifacts delete', { id: 'art_1', force: true }],
  ])('%s proceeds with --force', async (_label, root, path, args) => {
    const node = sub(root, path)

    await (node.run as (c: { args: unknown }) => Promise<void>)({ args })

    expect(del).toHaveBeenCalledTimes(1)
  })
})
