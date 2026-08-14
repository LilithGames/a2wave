import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../../../..')

/**
 * Both migrations that changed cross-replica arbitration are non-rolling, and
 * both failure modes are silent — an operator who does a normal rolling restart
 * gets data loss with no error to read. The only defence is that the policy is
 * stated in the two documents an operator actually consults, so this pins the
 * *policy* (stop every replica; mixed versions unsupported; both reasons) rather
 * than any one sentence, which would otherwise freeze the prose.
 */
describe('workspace removal reservation upgrade policy', () => {
  const documents = ['docs/agent/postgresql.md', 'docs/agent/scm-storage-invariants.md']

  it.each(documents)('%s requires a stop-the-world upgrade', (path) => {
    const document = readFileSync(resolve(repositoryRoot, path), 'utf8')

    // Stop every replica, not "restart them one at a time".
    expect(document).toMatch(/stop (?:all|every) .{0,40}replicas?/i)
    expect(document).toMatch(/mixed-version operation is unsupported|do not run mixed versions/i)
    expect(document).toMatch(/before applying|before upgrading/i)
  })

  it.each(documents)('%s names both non-rolling reasons', (path) => {
    const document = readFileSync(resolve(repositoryRoot, path), 'utf8')

    // Reason 1: an old remover deletes by id and erases the newer fence.
    expect(document).toMatch(/attempt[- ]token|deletes? .{0,40}by (?:stable )?id/i)
    // Reason 2: a pre-heartbeat replica writes no row and reads as dead.
    expect(document).toMatch(/heartbeat/i)
    expect(document).toMatch(/writes no .{0,30}row|no `?instance_heartbeats`? row/i)
  })
})
