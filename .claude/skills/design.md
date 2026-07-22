# @autonoma/blacklight - Design System Reference

> **Scope**: Use these guidelines when creating or modifying components in `packages/blacklight` or building UI in `apps/ui`.

## Critical: Correct Primary Token Usage

Blacklight ships a single theme (lime on void). `primary-ink` and `primary` currently resolve to the same lime, but they mean different things - keep using the right one so components stay correct if a token value ever changes.

### Use `primary-ink` for text, borders, and accents - NEVER raw `primary`

| Token | Value | Use for |
|-------|-------|---------|
| `primary` | `#CCFF00` (lime) | **Only** filled backgrounds (`bg-primary`) where foreground uses `text-primary-foreground` |
| `primary-ink` | `#CCFF00` (lime) | Text, borders, outlines, icons, progress indicators - anything that must be readable |
| `primary-foreground` | `#050505` | Text ON a `bg-primary` fill |
| `primary-contrast` | `#CCFF00` | Reserved for low-contrast surfaces |

**Rules:**
- `text-primary` - BANNED for body text/labels. Use `text-primary-ink` instead.
- `border-primary` - BANNED for subtle borders. Use `border-primary-ink/N` instead.
- `bg-primary` - OK only for filled elements (badges, step indicators) where text uses `text-primary-foreground`.
- SVG `stroke`/`fill` with CSS variables - must use `style={{ stroke: 'var(--primary-ink)' }}`, NOT SVG attributes (`stroke={color}`), because SVG attributes don't resolve CSS variables.
- Progress bars, sparklines, chart accents - override with `primary-ink` when placed outside filled containers.

### Status colors
`--status-critical`, `--status-success`, `--status-warn`, `--status-pending`, `--status-high` - use them directly.

### Surface/text/border tiers
`text-text-primary`, `bg-surface-base`, `border-border-dim` etc. - use them for standard UI.

---

## Design Tokens

### Colors

```
Primary:       --primary (#CCFF00 lime)      --primary-ink (lime)
Surfaces:      --surface-void > --surface-base > --surface-raised
Borders:       --border-dim > --border-mid > --border-highlight
Text:          --text-primary > --text-secondary > --text-tertiary
Status:        --status-critical (red)  --status-high (orange)
               --status-warn (yellow)   --status-success (green)
               --status-pending (blue)
Accent:        --accent-glow (lime 40%)  --accent-dim (lime 10% / violet 5%)
```

### Typography

- **Font Sans**: `DM Sans Variable` (`font-sans`)
- **Font Mono**: `Geist Mono Variable` (`font-mono`)
- Labels, badges, status text, metadata: always `font-mono`
- Body text, headings: `font-sans`

### Custom text sizes (below `text-xs` = 12px)

| Token | Size | Usage |
|-------|------|-------|
| `text-4xs` | 9px | Tiny labels |
| `text-3xs` | 10px | Stat values, metadata |
| `text-2xs` | 11px | Section headers, panel titles |

### Border radius

`--radius: 0rem` - everything is square by default. No `rounded-*` classes unless explicitly needed.

---

## Icons - Phosphor Icons

Use `@phosphor-icons/react`. **Import individually** to avoid barrel export perf issues:

```tsx
// GOOD
import { PlayIcon } from "@phosphor-icons/react/Play";

// BAD - barrel import
import { Play } from "@phosphor-icons/react";
```

Type: `import type { Icon } from "@phosphor-icons/react/lib";`

Weights: `thin`, `light`, `regular`, `bold`, `fill`, `duotone`. Use `weight="fill"` for active/selected states.

---

## Component Patterns

### Panel (standard card container)

```tsx
<Panel>
  <PanelHeader>
    <PanelTitle>SECTION TITLE</PanelTitle>
  </PanelHeader>
  <PanelBody>
    {content}
  </PanelBody>
</Panel>
```

PanelTitle auto-renders a small `bg-primary` dot prefix. If the panel has a custom background where lime is invisible, don't use Panel - build a custom container with `MilestoneCorners`-style decorations using `border-primary-ink/30`.

### Tooltips

```tsx
<Tooltip>
  <TooltipTrigger render={<Button variant="ghost" size="icon-xs" />}>
    <InfoIcon size={14} />
  </TooltipTrigger>
  <TooltipContent side="right">Tooltip text</TooltipContent>
</Tooltip>
```

### Button variants

| Variant | Use |
|---------|-----|
| `default` | Standard actions |
| `accent` | Important actions |
| `cta` | Primary CTA (angled clip-path + glow) |
| `outline` | Secondary actions |
| `ghost` | Tertiary, icon buttons |
| `destructive` | Danger actions |

### Badge variants

| Variant | Use |
|---------|-----|
| `status-passed` | Success states |
| `status-failed` | Error states |
| `status-running` | Active/processing |
| `status-pending` | Waiting |
| `ghost` | Neutral/muted |

### MetricCard

```tsx
<MetricCard>
  <MetricLabel>BUGS</MetricLabel>
  <MetricValue>
    42<MetricUnit>THIS MONTH</MetricUnit>
  </MetricValue>
</MetricCard>
```

### Progress

```tsx
<Progress value={75}>
  <ProgressLabel>Label</ProgressLabel>
  <ProgressValue>{() => "75%"}</ProgressValue>
</Progress>
```

Note: `ProgressValue` children must be a render function `(formattedValue, value) => ReactNode`.

To override the indicator color (e.g., for theme-safe `primary-ink`):
```tsx
<Progress className="[&_[data-slot=progress-indicator]]:bg-primary-ink" value={75}>
```

---

## Styling Rules

1. **No hardcoded pixel values** - use Tailwind scale classes or custom theme tokens. Never `text-[10px]`, `size-[14px]`, etc.
2. **No separate CSS files per component** - exception: SVG paint styles and `@keyframes`.
3. **Use `cn()`** for all className merging.
4. **Use CVA** for component variants.
5. **No business logic** in the blacklight package - pure presentational components only.
6. **Follow `biome.json`** formatting rules.

---

## Theme

| Theme | Class | Background | Accent |
|-------|-------|-----------|--------|
| Blacklight | `.blacklight` | `#050505` void | Lime |

The `.blacklight` class is static markup on the root HTML element (see `apps/ui/index.html`, `packages/blacklight/index.html`) - no provider component or runtime setup applies it. There is no theme switching.

---

## Checklist for New Components

- [ ] Uses `primary-ink` (not `primary`) for text, borders, icons
- [ ] Uses `primary` only for filled backgrounds with `primary-foreground` text
- [ ] Uses Phosphor icons with individual imports
- [ ] No hardcoded pixel values in Tailwind
- [ ] Uses `cn()` for className merging
- [ ] Follows Panel/PanelHeader pattern for card containers
- [ ] Uses `font-mono` for labels, badges, metadata
- [ ] No business logic - pure presentational
