# lightjj Design Language

## Principle: Color = Meaning, Shape = Type

Every color in the UI carries **semantic meaning**. Entity types (bookmarks, workspaces, PRs) are distinguished by **icons and typography**, not by unique hues.

---

## Tier 1: Semantic Core (4 colors only)

### Amber — Active / Changed / Brand
- Dark: `#ffa726` · Light: `#e68a00`
- Uses: brand accent, active/selected states, modified files, change IDs, working copy indicator, primary buttons, interactive elements

### Green — Added / Positive
- Dark: `#66bb6a` · Light: `#2e7d32`
- Uses: added files/lines, diff additions, synced/up-to-date status, success states, resolved conflicts

### Red — Removed / Negative
- Dark: `#ef5350` · Light: `#c62828`
- Uses: deleted files/lines, diff deletions, conflicts (both sides), errors, destructive actions

### Blue — Informational
- Dark: `#6880b8` · Light: `#4860a0`
- Uses: behind-sync status dot, question-severity annotations, informational (non-actionable) state

---

## Tier 2: Entity Badges — Neutral, distinguished by shape

Bookmarks, workspaces, and PRs are entity **types**, not semantic states. Icons and typography distinguish them — not color.

### Default badge (inactive)
- Background: `var(--surface0)`
- Border: `var(--surface1)`
- Text: `var(--subtext0)`
- Examples: `⑂ main`, `◇ default`, `↗ #142`

### Active badge (current)
- Background: `var(--bg-selected)` (amber soft tint)
- Border: amber at 20% opacity
- Text: `var(--amber)`

| Entity | Icon | Inactive | Active |
|--------|------|----------|--------|
| Bookmark | `⑂` | Neutral bg + neutral text | Amber tint bg + amber text |
| Workspace | `◇` | Neutral bg + neutral text | Amber tint bg + amber text |
| PR | `↗` | Neutral bg + neutral text | Amber tint bg + amber text |

---

## Tier 3: Graph Palette — Isolated and Muted

The revision graph uses multiple lane colors (`--graph-0`…`--graph-7`) to distinguish parallel branches:

- **Muted** (~60% saturation) so they don't compete with semantic tier
- **Reduced opacity**: lines at `0.45`, nodes at `0.8`
- **Maximally distinct from amber/green/red — enforced in code.** Builtin themes hand-pick 8 non-semantic hues. Ghostty-derived themes get the same guarantee from `pickGraphPalette()` (themes.ts): ANSI hue slots are ranked by color-distance from the theme's own amber/green/red, the most distinct hues fill the low lanes (where most commits sit on linear history), and every lane is muted 25% toward the background. (This replaced an older straight `p[N]` mapping that could make lane 0 == amber.)
- **Confined to revision-graph rows.** Exactly two consumers, both in RevisionGraph: the SVG gutter (pipes/nodes via GraphSvg) and the lane-tint on bookmark/PR badges (border + text hinting which lane the badge's commit is on). Never in panels, diffs, or other chrome. The deliberate crossover runs the *other* direction: the gutter's semantic nodes use Tier 1 colors at full opacity — working-copy `@` is amber, conflict `×` is red.

Each builtin theme hand-picks 8 hues; the default dark/light pair uses Ochre, Terra, Mauve, Plum, Slate, Teal, Moss, Olive. Nord/Gruvbox/Dracula/Tokyo Night/Rosé Pine use their native accent sets.

---

## Component Primitives

Shared UI primitives live in `theme.css` (global scope, not Svelte-scoped). Component CSS adds only layout/positioning overrides. Don't redefine these per-component.

## Theme system

`theme.css` is two layers:
- **~50 derived vars** in plain `:root` via `color-mix()` from primaries — theme-agnostic. `--bg-selected: color-mix(in srgb, var(--amber) 8%, transparent)` etc.
- **~32 primaries** per `:root[data-theme="X"]` block: base/mantle/crust/surface2/overlay0-1/subtext0-1/text + amber/green/red/blue/mauve/lavender + graph-0..7 + syn-* + backdrop/shadow-heavy.

Adding a builtin theme = one `:root[data-theme="X"]` block (~14 lines packed) + a `THEMES` entry in `themes.ts`. The 486 Ghostty themes are NOT CSS-baked — they ship as raw `{bg, fg, p[16]}` and `deriveTheme()` computes primaries at selection time, injected via `<style id="ghostty-theme-vars">`. Builtins exist for zero-FOUC first paint (the `:root` default is dark; ghostty themes need a chunk fetch before they can apply).

When adding a derived var, put it in the `:root` block as `color-mix(in srgb, var(--<primary>) N%, ...)` — NOT a per-theme hex. Per-theme hex means every new theme must define it; color-mix means zero work per theme.

### Shared component primitives

The canonical class-by-class list of shared primitives (buttons, segmented toggle, panel/modal chrome, prose, misc) lives in the project CLAUDE.md ("Shared UI primitives in `theme.css`") and in `frontend/src/theme.css` itself — don't duplicate it here. The design intent: one ghost-button family with amber primary / red danger / green success variants, amber `.active` states on segmented toggles, and shared panel/modal chrome so component CSS only adds layout/positioning overrides.

---

## Conflicts: Both sides red

Both conflict sides use **red** — because conflict = needs attention = red.
- Side A (current): full red intensity
- Side B (incoming): muted red (50% opacity border, reduced background)
- Distinguish by **label text** and **border weight**

---

## Discoverability

Every user-facing feature ships with a discoverability decision, not just the capability. A `tutorial-content.ts` What's-new entry is an announcement, not an affordance — it shows once.

Pick at least one **persistent** surface:

- **Toolbar inline hint** — the `.ann-hint` pattern ("Alt+click line to annotate") next to where the gesture applies
- **`<kbd class="nav-hint">` badge** on the control that triggers it
- **Right-click context menu entry** — also gives a non-modifier path to the same action
- **Cmd+K palette command** — makes the feature findable by name
- **StatusBar contextual shortcut** for mode-specific keys
- **One-time dismissible tip** (persisted seen-flag) — reserve for gesture-only features with no natural surface

Modifier-gesture-only or keyboard-only features (⌘+hover, bare keybinds) are not done until one of the above exists. Cautionary example: symbol peek (⌘+hover go-to-definition) shipped in v1.25.0 with only a What's-new entry and went unnoticed.

---

## Quick Reference

```
SEMANTIC (use everywhere):
  Amber  = active, changed, modified, brand, selected
  Green  = added, positive, synced, success
  Red    = deleted, negative, conflict, error

BADGES (entity types — neutral by default):
  ⑂ Bookmark  → neutral bg, amber if active
  ◇ Workspace → neutral bg, amber if active
  ↗ PR        → neutral bg, amber if active

GRAPH (isolated, decorative only):
  8 muted lane colors, 0.45 opacity lines, 0.8 opacity nodes
  Hues maximize distance from amber/green/red (hand-picked for builtins;
  pickGraphPalette() ranks + mutes for Ghostty themes).
  Used only in RevisionGraph rows: SVG gutter + lane-tinted bookmark/PR badges.
  Inverse crossover: semantic nodes @=amber, ×=red (Tier 1, full opacity).

DIFF:
  Added lines   → green bg + green text
  Removed lines → red bg + red text
  Word-level    → stronger green/red tint

CONFLICTS:
  Both sides    → red (side A stronger, side B muted)
  Boundary      → red (subtle) + label text
```
