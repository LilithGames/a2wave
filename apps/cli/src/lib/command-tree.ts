/**
 * A structural view of the citty command tree.
 *
 * `schema`, `docs` and `completion` all need to walk the same tree, and each
 * doing it with its own ad-hoc casts is how three descriptions of one CLI drift
 * apart. This module owns the walk and the shapes; the three consumers own only
 * their rendering.
 *
 * The tree is the authority for flags, descriptions, required-ness and defaults
 * — nothing here restates them, because a restatement is a copy that can be
 * wrong.
 */
import type { AgentMeta } from './agent-meta.js'

export interface ArgSpec {
  type?: string
  description?: string
  required?: boolean
  default?: unknown
  alias?: string | string[]
}

export interface TreeNode {
  meta?: { name?: string; description?: string; agentMeta?: AgentMeta }
  args?: Record<string, ArgSpec>
  run?: unknown
  subCommands?: Record<string, TreeNode>
}

export interface CommandEntry {
  /** Space-separated path WITHOUT the `a2wave` prefix, e.g. `agents delete`. */
  path: string
  node: TreeNode
  /** True when the node does work itself rather than routing to children. */
  leaf: boolean
}

/** Depth-first walk yielding every node under `root`, root itself excluded. */
export function walkCommands(root: TreeNode): CommandEntry[] {
  const out: CommandEntry[] = []
  const visit = (node: TreeNode, path: string[]): void => {
    const subs = Object.entries(node.subCommands ?? {})
    if (path.length > 0) {
      out.push({ path: path.join(' '), node, leaf: typeof node.run === 'function' })
    }
    for (const [name, sub] of subs) visit(sub, [...path, name])
  }
  visit(root, [])
  return out
}

/** Resolve a space-separated path against the tree, or undefined if absent. */
export function findCommand(root: TreeNode, path: string): TreeNode | undefined {
  let node: TreeNode | undefined = root
  for (const segment of path.trim().split(/\s+/).filter(Boolean)) {
    node = node?.subCommands?.[segment]
    if (!node) return undefined
  }
  return node
}

/** Every leaf path, in tree order — the list `docs` and `completion` render. */
export function leafPaths(root: TreeNode): string[] {
  return walkCommands(root)
    .filter((e) => e.leaf)
    .map((e) => e.path)
}
