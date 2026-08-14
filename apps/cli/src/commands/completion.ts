/**
 * `a2wave completion bash|zsh|fish` — a completion script derived from the tree.
 *
 * This is the one self-describing surface aimed at a human rather than an
 * agent: an agent reads `schema`. It earns its place because the script is
 * GENERATED from the same tree everything else reads, so it cannot describe a
 * command that no longer exists — which is the failure mode of every
 * hand-maintained completion.
 */
import { defineCommand } from 'citty'
import { assertShell, buildCompletion } from '../lib/completion.js'
import { getRootCommand } from '../lib/root-registry.js'

export const completionCommand = defineCommand({
  meta: {
    name: 'completion',
    description: 'Print a shell completion script (bash | zsh | fish)',
    agentMeta: {
      risk: 'read',
      notFor: ['Discovering commands programmatically — that is `a2wave schema`'],
      examples: [
        'a2wave completion bash > /etc/bash_completion.d/a2wave',
        'a2wave completion zsh > "${fpath[1]}/_a2wave"',
        'a2wave completion fish > ~/.config/fish/completions/a2wave.fish',
      ],
    },
  },
  args: {
    shell: { type: 'positional', description: 'bash | zsh | fish', required: true },
  },
  run: ({ args }) => {
    console.log(buildCompletion(getRootCommand(), assertShell(args.shell as string)))
  },
})
