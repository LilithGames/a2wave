import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { resolveUrl } from '../config.js'
import { CliError } from '../errors.js'
import { forceArgs, requireConfirmation, resolveForceFlag } from '../lib/args.js'
import { emit, jsonArg, wantsJson } from '../lib/output.js'
import { readSecret } from '../lib/prompt.js'
import { connectProviderOauth } from '../lib/provider-oauth-login.js'
import { openBrowser } from './oauth.js'

interface Account {
  id: string
  label: string
  email: string | null
  status: string
}
const providerArg = {
  provider: {
    type: 'string' as const,
    description: 'Codex Provider ID or name',
    default: 'Codex CLI',
  },
}
const accountArg = {
  id: { type: 'positional' as const, description: 'OAuth account ID', required: true as const },
}

async function readConnectionCode(): Promise<string> {
  if (process.stdin.isTTY)
    throw new CliError('--code-stdin requires piped input; omit it for a hidden prompt.')
  let code = ''
  for await (const chunk of process.stdin) {
    code += chunk.toString()
    if (code.length > 4096) throw new CliError('The connection code is too long.')
  }
  return code.trim()
}

export const providerAccountsCommand = defineCommand({
  meta: { name: 'accounts', description: 'Manage shared ChatGPT subscription accounts for Codex' },
  subCommands: {
    list: defineCommand({
      meta: {
        name: 'list',
        description: 'List connected ChatGPT accounts (without credentials)',
        agentMeta: { risk: 'read' },
      },
      args: { ...providerArg, ...urlArg, ...jsonArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url })
        const id = await client.resolveProviderId(args.provider)
        const result = await client.get<{ data: Account[] }>(`/api/providers/${id}/oauth-accounts`)
        if (emit(args, result)) return
        for (const account of result.data)
          console.log(`${account.id}  ${account.label}  ${account.email ?? '-'}  ${account.status}`)
        if (!result.data.length) console.log('No ChatGPT accounts connected.')
      },
    }),
    login: defineCommand({
      meta: {
        name: 'login',
        description: 'Connect a ChatGPT account using a browser on this computer',
        agentMeta: { risk: 'write' },
      },
      args: {
        ...providerArg,
        ...urlArg,
        ...jsonArg,
        server: { type: 'string', description: 'a2wave server URL (alias of --url)' },
        'login-id': { type: 'string', description: 'Pending connection ID shown in the Web UI' },
        'account-id': { type: 'string', description: 'Reconnect this existing account' },
        label: { type: 'string', description: 'Display label for a new account' },
        'code-stdin': {
          type: 'boolean',
          description: 'Read the Web connection code from stdin instead of a hidden prompt',
        },
        browser: {
          type: 'boolean',
          default: true,
          description: 'Open the browser; --no-browser only prints the local sign-in URL',
        },
      },
      run: async ({ args }) => {
        if (args.server && args.url && args.server !== args.url)
          throw new CliError('Use either --server or --url for the instance.')
        const server = resolveUrl(args.server ?? args.url)
        let loginId = args['login-id']
        let loginToken: string
        if (loginId) {
          if (args['account-id'] || args.label)
            throw new CliError('A Web login already defines its target account and label.')
          if (wantsJson(args) && !args['code-stdin'])
            throw new CliError(
              'Use --code-stdin with JSON output to keep the connection-code prompt out of stdout.',
            )
          loginToken = args['code-stdin']
            ? await readConnectionCode()
            : await readSecret('Paste the one-time connection code from a2wave (hidden): ')
        } else {
          const client = createClient({ url: server })
          const id = await client.resolveProviderId(args.provider)
          const { data } = await client.post<{ data: { loginId: string; loginToken: string } }>(
            `/api/providers/${id}/oauth-accounts/login`,
            {
              ...(args.label ? { label: args.label } : {}),
              ...(args['account-id'] ? { accountId: args['account-id'] } : {}),
            },
          )
          loginId = data.loginId
          loginToken = data.loginToken
        }
        if (!loginToken.trim()) throw new CliError('A one-time connection code is required.')
        const controller = new AbortController()
        const cancel = () => controller.abort()
        process.once('SIGINT', cancel)
        process.once('SIGTERM', cancel)
        try {
          const data = await connectProviderOauth({
            server,
            loginId,
            loginToken,
            signal: controller.signal,
            openBrowser: args.browser === false ? () => false : openBrowser,
            onReady: (url) => console.error(`Complete ChatGPT sign-in on this computer: ${url}`),
          })
          if (emit(args, { data })) return
          console.log(`Connected ChatGPT account: ${data.accountId}`)
          console.log('Return to a2wave to select the account and save the Agent.')
        } finally {
          process.removeListener('SIGINT', cancel)
          process.removeListener('SIGTERM', cancel)
        }
      },
    }),
    rename: defineCommand({
      meta: {
        name: 'rename',
        description: 'Change an account display label',
        agentMeta: { risk: 'write' },
      },
      args: {
        ...providerArg,
        ...accountArg,
        ...urlArg,
        ...jsonArg,
        label: { type: 'string', description: 'New label', required: true },
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url })
        const id = await client.resolveProviderId(args.provider)
        const result = await client.patch(
          `/api/providers/${id}/oauth-accounts/${encodeURIComponent(args.id)}`,
          { label: args.label },
        )
        if (!emit(args, result)) console.log(`Renamed account ${args.id}.`)
      },
    }),
    delete: defineCommand({
      meta: {
        name: 'delete',
        description: 'Disconnect and remove an unused ChatGPT account',
        agentMeta: { risk: 'high-risk-write' },
      },
      args: { ...providerArg, ...accountArg, ...urlArg, ...jsonArg, ...forceArgs },
      run: async ({ args }) => {
        await requireConfirmation(
          'high-risk-write',
          `Disconnect ChatGPT account ${args.id}?`,
          resolveForceFlag(args),
        )
        const client = createClient({ url: args.url })
        const id = await client.resolveProviderId(args.provider)
        const result = await client.del(
          `/api/providers/${id}/oauth-accounts/${encodeURIComponent(args.id)}`,
        )
        if (!emit(args, result)) console.log(`Disconnected account ${args.id}.`)
      },
    }),
  },
})
