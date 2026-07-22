# @autonoma/blacklight

Shared UI component library for Autonoma AI. Built on Base UI (Radix successor), Tailwind CSS v4, and CVA (class-variance-authority). Components follow shadcn/ui patterns - unstyled primitives composed with Tailwind utility classes and CSS custom properties for theming.

## Setup

Import the stylesheet once at your app entry point:

```ts
import "@autonoma/blacklight/styles.css";
```

Add the `blacklight` class to your root HTML element:

```html
<html lang="en" class="blacklight">
```

## Usage

```tsx
import { Button, Card, CardHeader, CardTitle, CardContent, Badge, Input } from "@autonoma/blacklight";
import { cn } from "@autonoma/blacklight";

function Example() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Test Results</CardTitle>
      </CardHeader>
      <CardContent>
        <Badge variant="outline">Passed</Badge>
        <Input placeholder="Filter..." />
        <Button variant="accent" size="sm">Run Again</Button>
      </CardContent>
    </Card>
  );
}
```

## Components

### UI Primitives

Button, Card, Dialog, Drawer, DropdownMenu, Popover, Select, Tabs, DataTable, SortableTable, Toast, Tooltip, Input, Textarea, Checkbox, Switch, Label, Badge, Alert, Progress, Separator, Skeleton, ScrollArea, MetricCard, Panel, Sparkline, StatusDot, AgentCube, ChartContainer, ScreenshotWithOverlay

### Command Display

Components for rendering execution agent commands in the UI:

- `stepInstruction` / `getUI` / `StepIcon` - render command steps with appropriate icons
- `InteractionBadge` - styled badge for command interaction types
- `commandColors` - color map for command types

### Utilities

- `cn(...inputs)` - merges class names via `clsx` + `tailwind-merge`
- `Logo` - Autonoma logo component with variants

## Theming

The theme is applied via a `blacklight` CSS class on the document root. All colors use CSS custom properties:

- **Semantic** - `--primary`, `--secondary`, `--accent`, `--destructive`, `--background`, `--foreground`
- **Surface** - `--surface-void`, `--surface-base`, `--surface-raised`
- **Border** - `--border-dim`, `--border-mid`, `--border-highlight`
- **Text** - `--text-primary`, `--text-secondary`, `--text-tertiary`
- **Status** - `--status-critical`, `--status-high`, `--status-warn`, `--status-success`
- **Accent** - `--accent-glow`, `--accent-dim`

The theme uses lime (#CCFF00) on near-black. Override any custom property on a class of your own to create a variant.

## Architecture Notes

- **Base UI primitives** - components use `@base-ui/react` as the unstyled primitive layer
- **CVA for variants** - every component with visual variants exposes a `cva`-based variants function (e.g., `buttonVariants`, `badgeVariants`)
- **Zero border radius** - `--radius` defaults to `0rem`, giving the design system its sharp, technical aesthetic
- **Fonts** - DM Sans Variable (sans) and Geist Mono Variable (mono)
- **Icons** - Phosphor Icons (`@phosphor-icons/react`)
- **shadcn CLI compatible** - `components.json` is configured so `shadcn add` works for scaffolding new components
- **Path alias** - `@/*` maps to `packages/blacklight/src/*` inside the package
- **ESM only** - package is `"type": "module"` with direct TypeScript source exports (no build step needed for consumers)

## Adding New Components

```bash
cd packages/blacklight
npx shadcn@latest add <component-name>
```

Components land in `src/components/ui/`. After adding, re-export from `src/index.ts`.
