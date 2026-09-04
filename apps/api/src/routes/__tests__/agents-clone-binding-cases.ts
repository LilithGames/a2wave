import { expect, it, vi } from 'vitest'
import { logAudit } from '../../lib/audit.js'
import { asyncQuery } from '../../test/async-query.js'

interface CloneTestApp {
  request(path: string, init: RequestInit): Response | Promise<Response>
}

interface CloneBindingTestContext {
  sampleAgent: Record<string, unknown>
  createApp(auth: { userId: string; role: 'admin' | 'user' }): Promise<CloneTestApp>
  makeSelectChain(result: unknown): unknown
  setSelectImplementation(implementation: () => unknown): void
  setInsertResult(value: unknown): void
}

function captureInsertedValues(
  setInsertResult: CloneBindingTestContext['setInsertResult'],
  cloneId: string,
): () => Record<string, unknown> {
  let captured: Record<string, unknown> = {}
  setInsertResult(
    asyncQuery({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        captured = values
        return asyncQuery({
          returning: vi
            .fn()
            .mockReturnValue(
              asyncQuery({ get: vi.fn().mockReturnValue({ ...values, id: cloneId }) }),
            ),
        })
      }),
    }),
  )
  return () => captured
}

/**
 * Register the SCM / KB binding projection cases beside the route suite without
 * letting the already broad agents.test.ts file exceed the repository limit.
 */
export function registerCloneBindingTests({
  sampleAgent,
  createApp,
  makeSelectChain,
  setSelectImplementation,
  setInsertResult,
}: CloneBindingTestContext): void {
  it("drops another owner's SCM source and KB documents when an editor clones (IDOR)", async () => {
    const editorApp = await createApp({ userId: 'usr_bob', role: 'user' })
    const source = {
      ...sampleAgent,
      userId: 'usr_alice',
      skills: [],
      skillGroupIds: [],
      mcpServerIds: [],
      kbDocumentIds: ['kbd_alice', 'kbd_bob'],
      workspaceType: 'scm',
      scmSourceId: 'scm_alice',
    }
    let selectCall = 0
    setSelectImplementation(() => {
      selectCall++
      if (selectCall === 1) return makeSelectChain(source) // requireAgentWrite
      if (selectCall === 2) return makeSelectChain({ role: 'editor' })
      if (selectCall === 3) {
        // KB visibility filter — the owner condition leaves only Bob's document.
        return {
          from: () => asyncQuery({ where: () => asyncQuery({ all: () => [{ id: 'kbd_bob' }] }) }),
        }
      }
      // Authoritative SCM re-read under the lifecycle lock: Alice owns the source.
      return makeSelectChain({ id: 'scm_alice', userId: 'usr_alice' })
    })
    const insertedValues = captureInsertedValues(setInsertResult, 'agt_clone_scm')

    const response = await editorApp.request('/agents/agt_original/clone', { method: 'POST' })

    expect(response.status).toBe(201)
    expect(insertedValues().scmSourceId).toBeNull()
    expect(insertedValues().workspaceType).toBe('temp')
    expect(insertedValues().kbDocumentIds).toEqual(['kbd_bob'])
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.clone',
        details: { droppedScmSourceId: 'scm_alice', droppedKbDocumentIds: ['kbd_alice'] },
      }),
    )
  })

  it("keeps another owner's SCM source and KB documents when the caller is admin", async () => {
    const adminApp = await createApp({ userId: 'usr_admin', role: 'admin' })
    const source = {
      ...sampleAgent,
      userId: 'usr_alice',
      skills: [],
      skillGroupIds: [],
      mcpServerIds: [],
      kbDocumentIds: ['kbd_alice'],
      workspaceType: 'scm',
      scmSourceId: 'scm_alice',
    }
    let selectCall = 0
    setSelectImplementation(() => {
      selectCall++
      if (selectCall === 1) return makeSelectChain(source) // requireAgentWrite
      return makeSelectChain({ id: 'scm_alice', userId: 'usr_alice' })
    })
    const insertedValues = captureInsertedValues(setInsertResult, 'agt_clone_admin_scm')

    const response = await adminApp.request('/agents/agt_original/clone', { method: 'POST' })

    expect(response.status).toBe(201)
    expect(insertedValues().scmSourceId).toBe('scm_alice')
    expect(insertedValues().workspaceType).toBe('scm')
    expect(insertedValues().kbDocumentIds).toEqual(['kbd_alice'])
  })
}
