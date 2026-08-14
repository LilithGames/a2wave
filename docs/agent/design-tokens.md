# Design System and Design Tokens (Web)

Applies to all UI implementations inside `apps/web`. Colors, radii, type scale, etc. must go through the established tokens; avoid scattering bare hex values or magic numbers disconnected from the theme across business components.

## Theme architecture and source of truth

The typed registry in `apps/web/src/lib/themes.ts` is the runtime source of truth. Every
`ThemeDefinition` owns its appearance, semantic colors, status colors, editor/Markdown colors,
radii, shadows, scrollbar treatment, preview metadata, and Ant Design structural values.
Business components consume semantic CSS variables and must never branch on a theme id.

`ThemeProvider` owns the personal `a2wave.theme` preference in `localStorage`, live preview state,
cross-tab storage events, and `prefers-color-scheme` changes. The special `system` preference
resolves to Wave Light or Wave Dark immediately. It applies these stable root attributes for CSS,
tests, and support diagnostics:

| Attribute | Meaning |
|------|------|
| `data-theme-preference` | Stored choice (`system` or a concrete theme id) |
| `data-theme` | Currently resolved concrete theme id |
| `data-appearance` | `light` or `dark` |

`index.html` contains a deliberately tiny synchronous bootstrap that resolves only those
attributes before first paint. The theme selectors in `globals.css` are first-paint mirrors of the
registry; React immediately reapplies the typed registry as inline variables. When a ThemeSpec
value changes, update its CSS mirror in the same change so a cold page load and the hydrated app
cannot diverge.

## Three-layer token structure

| Layer | Meaning | Location |
|------|------|------|
| Layer 1 — Primitive | Neutral and status scales, base font weights | `ThemeDefinition.tokens.neutral/emerald/amber/red`; `--color-warm-*` and status variables |
| Layer 2 — Semantic | Background, body text, border, primary, statuses, code and overlays | `ThemeDefinition.tokens`; `--color-background`, `--color-primary`, `--color-code-*`, `--color-overlay`, etc. |
| Layer 3 — Component | Sidebar, Tab, radii, elevation and other shared conventions | `ThemeDefinition.radii/shadows/antd` and matching CSS variables |

`tokens.ts` converts the active ThemeSpec into one Ant Design `ThemeConfig`; it does not own a
second palette.

Sidebar navigation is intentionally isolated from generic brand states. Each theme must provide
`sidebarActiveBackground`, `sidebarActiveForeground`, and `sidebarActiveBorder`; the active pair
must pass WCAG AA. `layout.tsx` consumes only the matching `bg/text/border-sidebar-active-*`
utilities. Do not rebuild active navigation with `primary`, opacity math, or inline RGB shadows.

Public authentication routes keep the persisted theme before a user signs in. The login brand
panel therefore owns `brandPanel`, `brandPanelForeground`, and `brandPanelMutedForeground` rather
than a fixed light gradient. Both text roles must pass WCAG AA against the panel surface. Decorative
wave/grid colors derive from semantic theme variables; the login component must not branch on a
theme id or embed a separate palette. Standardized SSO logos that require a neutral backing use
`brandMarkSurface` instead of a raw `bg-white` utility.

`primary` is a brand **fill/border** token, not a general-purpose text color. Themes with a bright
brand fill (Neo Yellow in particular) cannot use it legibly for small links, selected labels, or
icons on pale surfaces. Use `interactiveForeground` / `text-interactive-foreground` for those
foregrounds. Every theme's interactive foreground must pass WCAG AA against `background`, `card`,
and `primarySubtle`; Ant Design's link tokens are mapped to it as well.

## Adding or changing a theme

1. Add or update one `ThemeDefinition` in `themes.ts`. Use semantic roles; do not add a raw
   palette branch inside a component.
2. Give the theme a declared `light` or `dark` appearance and complete every token. A theme is not
   accepted if it only changes `primary`.
3. Mirror the cold-start variables in the matching `html[data-theme="…"]` block in `globals.css`
   and include the id in the `index.html` bootstrap allowlist.
4. Add aligned Chinese and English name/description keys and a miniature preview card.
5. Verify WCAG AA text contrast, visible keyboard focus, semantic status contrast, Ant Design
   portals, PromptEditor, Markdown callouts, run logs, scrollbars, and reduced motion.
6. Extend unit tests and the appearance E2E gallery. Review Dashboard and Agents at minimum, plus
   representative editor, modal, table, Markdown and run-log states.

Never copy a third-party theme file into this registry. Visual references and licenses belong in
[`docs/design/theme-sources.md`](../design/theme-sources.md).

## Tailwind and semantic classes

Prefer Tailwind classes that map to semantic tokens rather than arbitrarily writing `text-[#333]` or `bg-white` (unless it exactly matches an existing token and a semantic class is already available).

Common patterns (consistent with the root-level UI conventions):

- Body text/labels: `text-foreground`, `text-sm font-medium text-foreground`
- De-emphasized copy: `text-muted-foreground`
- Links and interactive text/icons: `text-interactive-foreground`
- Surfaces and borders: `bg-muted/60`, `border-border`, `bg-card`
- Info areas: `rounded-lg bg-muted/60 px-3 py-2.5` (paired with an Info icon, not antd Alert)
- Code blocks: `rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm`
- Placeholders: `rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground`

## Hover and selected states

Interactive surfaces — list rows, tabs, ghost/outline buttons — use two dedicated tokens:

| State | Class | Value |
|---|---|---|
| Hover | `hover:bg-surface-hover` | `--color-primary` at 5%, translucent |
| Selected / active | `bg-surface-selected` | `--color-primary` at 10%, translucent |

**Never write `hover:bg-muted`, `hover:bg-muted/60`, `hover:bg-accent`, or `hover:bg-warm-50`.** Two reasons this is a rule and not a preference:

1. `--color-muted` doubles as a *resting* surface — rows commonly sit at `bg-muted/40`. Hovering to a full `bg-muted` collapses resting and hover onto one scale, so the hover reads as a heavy grey slab dropping over the row rather than as a lift.
2. The tokens are **translucent**, so one value composites correctly over white cards, tinted rows, and panel headers alike. An opaque grey has to be re-tuned for every backdrop, which is how the codebase ended up with sixteen different hover values.

Hover and selected are two stops of the *same* indigo, so pointing at a row previews the color it takes when chosen instead of flashing grey and then jumping to a brand tint.

The sidebar is the component-level exception: inactive hover uses `sidebarMuted` and active items
use the three `sidebarActive*` tokens above. This keeps Neo Yellow's paper sidebar and every dark
theme's depth language independent from the main content accent.

Keep using the solid-fill hovers where a control already has a solid resting fill (`hover:bg-primary/90` on primary buttons, `hover:bg-secondary/80`, `hover:bg-destructive/90`) — those darken a fill rather than tinting a surface. Destructive affordances keep `hover:bg-destructive/10`.

## Aligning Ant Design with tokens

The global theme comes from `createAntdTheme(activeTheme)` in
`apps/web/src/lib/tokens.ts`, injected in `app.tsx` via `<ConfigProvider>`. Dark ThemeSpecs use
Ant Design's `darkAlgorithm`, while explicit semantic tokens still control its container, layout,
text, border, status, hover, radius, and overlay surfaces.

- **Do not** duplicate a `token` object in business code that overlaps with the config returned by `createAntdTheme()`.
- To adjust shared colors/radii/elevation, change the ThemeSpec and its first-paint CSS mirror rather
  than overriding token objects in a page.

## Modal / Dialog

Use the project's wrapped Dialog (antd `Modal`), keeping the **mask, corner radius, border, shadow**, etc. consistent with [`apps/web/src/components/ui/dialog.tsx`](../../apps/web/src/components/ui/dialog.tsx): `footer={null}`, `closable={false}`, custom close button in the top-right. The active Ant Design theme's `token.borderRadius` and the local `borderRadius` on the Modal wrapper may differ; **the wrapper component is authoritative**.

### Entity create/edit modals

Entity CRUD (MCP Server / Group, Skill, SCM Source, KB Document, …) is done in a **modal opened from the list page**, not a dedicated `/new` + `/:id` detail route. Reference implementations: `apps/web/src/components/{mcp,skill,kb,scm}/*-form.tsx` (+ `*-form-modal.tsx`). The shape:

- **Two files per entity**: a `XxxForm` (the fields + submit/delete logic, props `{ id?, onSaved, onDeleted? }`, `isCreateMode = !id`) and a thin `XxxFormModal` shell (`Dialog` + title). The list page holds `useState<{ open; id? }>` and renders one modal; `New` opens create, a card `onClick` opens edit, an upload lands on the created id.
- **Remount by key**: `<XxxForm key={id ?? 'new'} … />` so create/edit state never leaks between opens.
- **`scrollBody` + pinned bars**: pass `scrollBody` to `Dialog`; the **form** owns scrolling as a flex column (`flex max-h-[70vh] flex-col`) — a `min-h-0 flex-1 overflow-y-auto -mr-5 pr-5` body between a **pinned tab/action header** and a **pinned save-bar footer** (`shrink-0 … border-t border-border/60 pt-3`). Never leave the Save button or a tab switcher inside the scrolling region. Give the scroll body a `min-h-[24rem]`-ish floor so switching tabs doesn't resize the modal.
- **Edit-only features** (file lists, sync/probe status, delete/reupload actions, polling queries) are gated on an existing `id`; create mode shows only what a not-yet-existing entity supports.
- **Card → modal a11y**: list cards become `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter/Space). Any inner action control on the card (a sync button, a `⋯` kebab) must `stopPropagation` on **both `onClick` and `onKeyDown`**, or keyboard-activating it also fires the card's open handler.

### Segmented (type / mode pickers)

For choosing one option from a small mutually-exclusive set (SCM Git/P4, MCP transport, KB source, list filters, tab switchers), use **`ModePicker`** ([`components/ui/mode-picker.tsx`](../../apps/web/src/components/ui/mode-picker.tsx)) — it is the single standard; do not reach for antd `Segmented` directly, and do not hand-roll button rows, custom pill controls, or native radios. It wraps `Segmented`, themed in `antdTheme.components.Segmented` + `.ant-segmented*` rules in `globals.css`.

- **Options are data, not markup**: `options={[{ value, label, icon?, disabled? }]}`, where `icon` is the `LucideIcon` itself. The wrapper renders the icon at one fixed size for the whole app. This exists because the icon+label span was previously copied by hand at every call site and the copies drifted — some `h-4 w-4`, others `h-3.5 w-3.5`, so two pickers on one page did not align — and one site shipped `size="small"`, reading as a different control rather than a smaller one. **Do not pass `size`.**
- The generic infers from `value`, so `onChange` hands back the union type rather than `string`; no `as` cast at the call site.
- The one sanctioned exception is a deeply nested, dense editor row (`mcp-group-form`'s per-backend type), which keeps a raw `size="small"` `Segmented`.
- Selected item is a **solid `primary` fill with `primary-foreground` text**; `globals.css` force-sets the selected label + icon to `--color-primary-foreground` (the custom label span otherwise lets the lucide icon inherit the muted colour and lose contrast).
- **Do not** `transition: none` the thumb — rc-segmented clears its internal `thumbShow` on the thumb's `transitionend`, so killing the transition strands the just-clicked item without the `-selected` class (dark text). Use a 1ms thumb transition instead (imperceptible, still fires `transitionend`); label colour transitions are off so text snaps rather than fading through an intermediate tone.
- Width: let it size to content for a 2–3 option picker; put the label on its own row (`flex flex-col items-start gap-1.5`) rather than inline with the control.

### Form fields

- **Placeholder-first**: every text `Input`/`Textarea` gets a `placeholder`. Prefer a placeholder over a separate muted `<p>` helper line when the helper only restates the field's format/example. Keep helper text only for a real constraint/warning/security note (PAT scope, "leave blank to keep current secret", permission tips).
- **Label style**: `<Label className="text-sm">` inside a `<div className="space-y-1.5">` wrapper. Avoid the heavier `text-sm font-medium text-foreground` + `mt-1.5`-on-input pattern.
- **Save button**: icon + text, with a spinner while pending — `{pending ? <Loader2 className="h-4 w-4 animate-spin" /> + savingText : <Save className="h-4 w-4" /> + saveText}`. Do not ship a text-only save button.

## Provider Brand Icons

Preset Providers are rendered uniformly via `getProviderIconSpec(name)` from `@/components/provider-icon` in cards, detail-page headers, and other locations; it returns a `{ Icon, bgClass, fgClass }` triple, and the caller composes the tile size itself. Provider brand tiles are the deliberate exception to semantic status colors: their light/dark classes preserve official glyph contrast and must be visually checked across all themes.

This table is the authoritative provenance record for every file in
`apps/web/src/assets/provider-icons/`. It must list **all** of them — the
attribution block in [`NOTICE`](../../NOTICE) is derived from it, so a file
added here without a row silently under-reports what the build redistributes.
All rows recorded 2026-08-07.

| Provider | Asset | Source | License / basis | `fgClass` |
|---|---|---|---|---|
| Cursor CLI | `cursor.svg` | [Simple Icons](https://simpleicons.org/?q=cursor) | CC0 1.0 (copyright waived; **trademark is not** — see NOTICE) | `text-zinc-900` |
| Claude Code | `claude-color.svg` | [lobe-icons](https://github.com/lobehub/lobe-icons) | MIT, © 2023 LobeHub → [`licenses/lobe-icons-MIT.txt`](../../licenses/lobe-icons-MIT.txt) | `text-orange-600 dark:text-orange-300` (SVG bakes in the Anthropic brand color `#D97757`) |
| Codex CLI | `openai.svg` | [lobe-icons](https://github.com/lobehub/lobe-icons) | MIT, © 2023 LobeHub → [`licenses/lobe-icons-MIT.txt`](../../licenses/lobe-icons-MIT.txt) | `text-neutral-900` |
| Pi CLI | `pi.svg` | [pi.dev](https://pi.dev/logo-auto.svg) | MIT, © 2025 Mario Zechner → [`licenses/pi-MIT.txt`](../../licenses/pi-MIT.txt) | `text-zinc-900` |
| Kimi CLI | `kimi.png` | Official Moonshot AI app icon | Brand mark — nominative use, no copyright license granted | `text-neutral-50` |
| Qoder | `qoder.svg` | Official Alibaba Qoder brand mark (cropped from the source export) | Brand mark — nominative use, no copyright license granted | `text-neutral-50` |
| Trae | `trae.png` | Official ByteDance Trae app icon | Brand mark — nominative use, no copyright license granted | `text-neutral-50` |
| OpenCode | `opencode.svg` | Generic terminal glyph — **not** the official OpenCode mark | Believed original to a2wave (Apache-2.0); authorship pending confirmation | `text-stone-900` |
| Other | — | Falls back to lucide-react `Shield` | — | `text-blue-600 dark:text-blue-300` |

Every mark shares one neutral tile, `PROVIDER_ICON_TILE`; there is deliberately
no per-brand `bgClass` (see the rationale comment in `provider-icon.tsx`).

Conventions:

- When adding a Provider with an icon, put the SVG into `apps/web/src/assets/provider-icons/` (prefer CC0 / MIT sources to avoid trademark disputes), then add a `case 'Xxx'` dispatch in the `switch` of `provider-icon.tsx`.
- **Record it in the table above in the same commit**, with the source URL and the date retrieved. If it is MIT-licensed (or any license requiring attribution), also drop the upstream license text into `licenses/` and reference it from `NOTICE` — MIT obliges us to ship the copyright notice with the redistributed copy, and the built web bundle is a redistribution.
- Delete the asset when its `case` goes away. An unreferenced brand file carries the same obligations as a used one while benefiting nobody — `anthropic.svg` sat unused in the tree for exactly this reason.
- SVGs are loaded via Vite's default URL import (`import url from '@/assets/provider-icons/x.svg'` + `<img src={url}>`). Do not inline them as React components — build outputs use hash-based CDN for better caching, and it avoids path data polluting the source.
- If the icon needs to change with the theme color (light / dark), prefer a monochrome SVG with `fill="currentColor"` so that the tile's `fgClass` actually takes effect; for a colored brand SVG (like Claude's swirl), `fgClass` only affects other elements inside the tile (auxiliary text, etc.).

## Reference Implementations

- Tokens and antd theme: [`apps/web/src/lib/tokens.ts`](../../apps/web/src/lib/tokens.ts)
- CSS variables and Tailwind `@theme`: [`apps/web/src/styles/globals.css`](../../apps/web/src/styles/globals.css)
- Provider icon mapping: [`apps/web/src/components/provider-icon.tsx`](../../apps/web/src/components/provider-icon.tsx)
- App entry: `apps/web/src/app.tsx`
