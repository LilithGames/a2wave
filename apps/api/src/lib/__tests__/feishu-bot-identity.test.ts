import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createBotIdentityResolver } from '../feishu-bot-identity.js'

describe('createBotIdentityResolver', () => {
  it('retries a failed probe instead of latching the failure', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('feishu blip during boot'))
      .mockResolvedValue({ bot: { open_id: 'ou_bot' } })
    const resolver = createBotIdentityResolver({ request }, 'agt_1')

    // The probe used to run exactly once. A failure left the identity undefined
    // for the whole process lifetime, so every group message fell back to
    // matching `@_user_1` — the first mention in the message, whoever it points
    // at — until someone restarted the process.
    expect(await resolver.resolve()).toBeUndefined()
    expect(await resolver.resolve()).toBe('ou_bot')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight probe between concurrent callers', async () => {
    const request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } })
    const resolver = createBotIdentityResolver({ request }, 'agt_1')

    const [a, b] = await Promise.all([resolver.resolve(), resolver.resolve()])

    expect(a).toBe('ou_bot')
    expect(b).toBe('ou_bot')
    expect(request).toHaveBeenCalledOnce()
  })

  it('serves a resolved identity without probing again', async () => {
    const request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } })
    const resolver = createBotIdentityResolver({ request }, 'agt_1')

    await resolver.resolve()
    await resolver.resolve()

    expect(request).toHaveBeenCalledOnce()
  })

  it('reports the identity known right now without waiting on a probe', async () => {
    let release: (v: unknown) => void = () => {}
    const request = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const resolver = createBotIdentityResolver({ request }, 'agt_1')

    // Message handling reads `current()` so a slow or hung probe cannot strand a
    // message that Feishu has already ACKed.
    const pending = resolver.resolve()
    expect(resolver.current()).toBeUndefined()

    release({ bot: { open_id: 'ou_bot' } })
    await pending
    expect(resolver.current()).toBe('ou_bot')
  })

  it('notifies once resolved, so a late probe can refresh stored copies', async () => {
    const request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } })
    const onResolved = vi.fn()

    await createBotIdentityResolver({ request }, 'agt_1', onResolved).resolve()

    expect(onResolved).toHaveBeenCalledWith('ou_bot')
  })
})
