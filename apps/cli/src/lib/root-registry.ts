/**
 * Late-bound handle on the root command tree.
 *
 * `schema`, `docs` and `completion` all need to walk the whole tree, but they
 * are themselves registered IN that tree — importing it directly would be a
 * cycle. `src/index.ts` calls `setRootCommand` once, immediately after building
 * the tree, and the three self-describing commands read it back here.
 *
 * A registry rather than a lazy import because the alternative — each command
 * dynamically importing `index.js` — would re-run the entry point's dispatch.
 */
import { CliError } from '../errors.js'
import type { TreeNode } from './command-tree.js'

let root: TreeNode | undefined

export function setRootCommand(node: TreeNode): void {
  root = node
}

export function getRootCommand(): TreeNode {
  if (!root) {
    // Reachable only if a self-describing command is invoked outside the entry
    // point (a unit test importing it standalone). Naming the cause beats a
    // TypeError on `undefined.subCommands`.
    throw new CliError('Command tree is not registered.', { type: 'internal' })
  }
  return root
}
