import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { resolveUrl } from '../config.js'
import { emit, jsonArg } from '../lib/output.js'

interface MeUser {
  id?: string
  username?: string
  displayName?: string | null
  role?: string
}

/**
 * "As whom will my next call run, and against which instance?"
 *
 * Deliberately separate from `status`, which answers the broader "is everything
 * healthy" and pays for four probes to do it. An agent calls `whoami` before a
 * risky write — a delete, a publish, an admin-only route — and that check has
 * to be cheap enough to be worth making. One request, one answer.
 *
 * The instance URL is part of the answer, not decoration: the same account can
 * be an administrator on one deployment and a viewer on another, so an identity
 * without the deployment it applies to is not actionable.
 */
export const whoamiCommand = defineCommand({
  meta: {
    name: 'whoami',
    agentMeta: { risk: 'read' },
    description: 'Show the identity and instance the next command will act as',
  },
  args: { ...jsonArg, ...urlArg },
  run: async ({ args }) => {
    const url = resolveUrl(args.url as string | undefined)
    const client = createClient({ url: args.url as string | undefined })
    const { data } = await client.get<{ data: MeUser }>('/api/auth/me')

    // Project rather than pass the payload through: /auth/me is free to grow,
    // and an agent asking "who am I" should not have to skip past fields it did
    // not ask for. Also means no future credential-shaped column can ride along.
    const user = {
      id: data.id,
      username: data.username,
      displayName: data.displayName,
      role: data.role,
    }
    // Surfaced as a boolean so an agent deciding whether to attempt an
    // admin-only route need not know the role string is spelled "admin".
    const isAdmin = data.role === 'admin'

    if (emit(args, { url, user, isAdmin })) return

    console.log(`Instance: ${url}`)
    console.log(`User:     ${user.username ?? '<unknown>'}`)
    if (user.displayName) console.log(`Display:  ${user.displayName}`)
    console.log(`Role:     ${user.role ?? '<unknown>'}`)
    console.log(`ID:       ${user.id ?? '<unknown>'}`)
  },
})
