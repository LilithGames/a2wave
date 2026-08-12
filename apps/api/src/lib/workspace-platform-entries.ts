import { PRESET_PROVIDERS } from '@a2wave/shared'
import { BUILTIN_PROVIDER_MANIFESTS } from '../engine/provider-catalog.js'

function topSegment(path: string): string {
  return path.split('/')[0]
}

/**
 * Top-level workspace entries the platform itself writes into run workspaces,
 * derived from the Provider definitions — the single source of truth — plus
 * the platform's own artifacts. Two consumers share this set so they can never
 * drift again:
 * - workspace removal treats these as disposable platform output (a workspace
 *   root that only carries these must be removable), and
 * - the followSource pinning check must never count changes under them as
 *   agent work.
 * Known limitation: a per-Agent skillsDir override diverging from every preset
 * is not derivable here.
 */
export function platformWorkspaceEntries(): ReadonlySet<string> {
  const entries = new Set<string>(['.codegraph'])
  for (const preset of PRESET_PROVIDERS) {
    if (preset.skillsDir) entries.add(topSegment(preset.skillsDir))
  }
  for (const manifest of Object.values(BUILTIN_PROVIDER_MANIFESTS)) {
    const delivery = manifest.capabilities?.mcpDelivery
    if (delivery?.mode === 'workspace-file' && delivery.defaultPath) {
      entries.add(topSegment(delivery.defaultPath))
      // Root-level config files get a sibling carrier written by the engines.
      if (!delivery.defaultPath.includes('/')) {
        entries.add(`${delivery.defaultPath}.a2wave-managed`)
      }
    }
  }
  return entries
}
