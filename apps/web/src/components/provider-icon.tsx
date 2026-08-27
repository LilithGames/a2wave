/**
 * Provider brand icons.
 *
 * SVG sources:
 *   - Claude   — lobehub/lobe-icons (MIT), brand-colored swirl
 *   - OpenAI   — lobehub/lobe-icons (MIT), used for Codex CLI
 *   - Cursor   — simpleicons.org (CC0)
 *   - Qoder    — official brand mark (green glyph with a white cutout), cropped
 *     from the wordmark; paired with a dark tile so the cutout reads
 *   - Trae     — official app icon (green glyph on black), raster PNG with its
 *     own dark background baked in
 *   - Kimi     — official app icon (white "K" with a blue dot on black), raster
 *     PNG with its own dark background baked in
 *   - Copilot  — GitHub octocat mark (simpleicons.org)
 *   - Pi       — official Pi logo (MIT)
 *
 * Local svgs live in src/assets/provider-icons/. Vite turns each import into a
 * hashed URL, rendered directly via <img src=...>. Claude's swirl carries its
 * brand color #D97757 and needs no external tint; Cursor / OpenAI are
 * single-color paths that show black on a light tile.
 */

import type { ProviderKind } from '@a2wave/shared'
import { Shield } from 'lucide-react'
import type { ReactElement } from 'react'
import claudeIconUrl from '@/assets/provider-icons/claude-color.svg'
import cursorIconUrl from '@/assets/provider-icons/cursor.svg'
import kimiIconUrl from '@/assets/provider-icons/kimi.png'
import openaiIconUrl from '@/assets/provider-icons/openai.svg'
import opencodeIconUrl from '@/assets/provider-icons/opencode.svg'
import piIconUrl from '@/assets/provider-icons/pi.svg'
import qoderIconUrl from '@/assets/provider-icons/qoder.svg'
import traeIconUrl from '@/assets/provider-icons/trae.png'

export interface ProviderIconSpec {
  /** Renders an icon (the caller picks the size, e.g. h-5 w-5) */
  Icon: (props: { className?: string }) => ReactElement
  /**
   * Tailwind class: foreground (icon) color. No effect when `Icon` is an
   * `<img>` — it only tints the lucide fallback.
   *
   * There is deliberately no `bgClass`. The tile behind a mark is one shared
   * neutral surface owned by the call site, not a per-brand color: several
   * assets (Kimi, Trae, Qoder) bake their own dark rounded tile in, and a
   * matching dark wrapper drew a second square around the first.
   */
  fgClass: string
}

/**
 * The shared tile behind every provider mark.
 *
 * One surface for all brands rather than a per-brand color: the old per-brand
 * backgrounds painted a dark square behind the marks that already bake their
 * own dark rounded tile into the asset (Kimi, Trae, Qoder), so the icon read as
 * a square inside a square. Dropping the tile altogether was worse — Qoder's
 * shape floated with nothing to sit on, and OpenCode disappeared outright.
 *
 * It stays light in dark themes on purpose, which is the one rule here that
 * looks wrong until you know why. Every mark is rendered as an `<img>`, so the
 * three assets drawn with `fill="currentColor"` (OpenCode, OpenAI, Pi) cannot
 * inherit a foreground and always paint black. A tile that darkened with the
 * theme would erase exactly those three. Slightly dimmed in dark mode so it
 * does not glare next to a muted card.
 */
export const PROVIDER_ICON_TILE = 'bg-muted/60 dark:bg-zinc-200'

function makeImgIcon(src: string, alt: string) {
  return ({ className }: { className?: string }) => (
    <img src={src} alt={alt} className={className} draggable={false} />
  )
}

const SHIELD_FALLBACK: ProviderIconSpec = {
  Icon: ({ className }) => <Shield className={className} aria-hidden="true" />,
  fgClass: 'text-blue-600 dark:text-blue-300',
}

/** Return the brand icon for a stable Provider kind. */
export function getProviderIconSpec(kind: ProviderKind | undefined): ProviderIconSpec {
  switch (kind) {
    case 'claude-code':
      return {
        Icon: makeImgIcon(claudeIconUrl, 'Claude'),
        fgClass: 'text-orange-600 dark:text-orange-300',
      }
    case 'codex':
      return {
        Icon: makeImgIcon(openaiIconUrl, 'OpenAI'),
        fgClass: 'text-neutral-900',
      }
    case 'cursor':
      return {
        Icon: makeImgIcon(cursorIconUrl, 'Cursor'),
        fgClass: 'text-zinc-900',
      }
    case 'opencode':
      return {
        Icon: makeImgIcon(opencodeIconUrl, 'OpenCode'),
        fgClass: 'text-stone-900',
      }
    case 'qoder':
      return {
        Icon: makeImgIcon(qoderIconUrl, 'Qoder'),
        fgClass: 'text-neutral-50',
      }
    case 'trae':
      return {
        Icon: makeImgIcon(traeIconUrl, 'Trae'),
        fgClass: 'text-neutral-50',
      }
    case 'kimi':
      return {
        Icon: makeImgIcon(kimiIconUrl, 'Kimi'),
        fgClass: 'text-neutral-50',
      }
    case 'pi':
      return {
        Icon: makeImgIcon(piIconUrl, 'Pi'),
        fgClass: 'text-zinc-900',
      }
    default:
      return SHIELD_FALLBACK
  }
}
