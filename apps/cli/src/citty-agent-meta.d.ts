/**
 * Widen citty's own `CommandMeta` so `defineCommand` accepts `agentMeta`.
 *
 * Declaration merging rather than a cast at every call site: citty exports
 * `CommandMeta` as a plain interface, and merging keeps `risk` type-checked
 * inside all ~110 command definitions. Casting instead would make every label a
 * free-form string — exactly what the structural test in
 * src/__tests__/command-structure.test.ts exists to prevent.
 *
 * It lives in an ambient `.d.ts` rather than beside `AgentMeta` in lib/, because
 * an augmentation inside a module only applies where that module is imported,
 * and command files never import the type — they just write the literal.
 */
import type { AgentMeta } from './lib/agent-meta.js'

declare module 'citty' {
  interface CommandMeta {
    agentMeta?: AgentMeta
  }
}
