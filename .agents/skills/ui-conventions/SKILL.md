---
name: ui-conventions
description: "Always read this skill before editing any file under apps/ui/. Contains all UI conventions, data fetching patterns, design system rules, and component guidelines for the Vite + React 19 SPA."
---

# UI App — Vite + React 19 SPA

## Stack

- **Vite** with React 19 and TypeScript (strictest config)
- **TanStack Router** — file-based routing with auto-generated route tree
- **React Query + tRPC** — type-safe data fetching via `queryOptions` / `mutationOptions`
- **React Compiler** — enabled via `babel-plugin-react-compiler`. Never write explicit `useCallback` or `useMemo`.
- **@autonoma/blacklight** — shared component library (Radix + Tailwind CSS v4 + CVA). Always use for UI components.
- **Phosphor Icons** (`@phosphor-icons/react`) - all icons. Import individually, never barrel imports.
- **PostHog** — analytics (centralized, never add manual `posthog.capture()` in components)
- **Sentry** — error tracking

## Scripts

- **`pnpm typecheck`** - runs `tsc --noEmit`. Prefer the root `pnpm typecheck` to catch cross-package issues. Use the local `pnpm --filter @autonoma/ui typecheck` only when other packages have type errors unrelated to the current task and generate too much noise.
- **`pnpm generate-routes`** - calls `vite build`. Use this to regenerate the TanStack Router route tree after adding, removing, or renaming route files.
- **`pnpm build`** - runs typecheck then `vite build`. Prefer the root `pnpm build` as well.
- **`pnpm lint`** - runs `oxlint --fix` on `src/`.

## React Principles

### Minimize `useEffect` and `useRef`

Avoid `useEffect` for derived state or data fetching — use React Query and computed values instead. Only use `useEffect` for true side effects (DOM manipulation, subscriptions). Avoid `useRef` unless interacting with DOM nodes directly.

### Avoid Prop Drilling

When data needs to flow through multiple component layers, prefer React contexts over passing props through intermediaries.

- Only introduce a context when the alternative is drilling through 2+ levels — don't over-abstract for single-level passing.
- Avoid contexts when they would result in large performance overhead (e.g., frequently-updating values that would cause many re-renders).

### Push State Down

If a piece of state is only consumed by a single child component, move it into that child. Keep state as close to where it's used as possible. Parent components should not manage state on behalf of children unless the state is shared.

### Encapsulate Complex Behavior in Custom Hooks

Extract non-trivial logic (data fetching + transformation, multi-step flows, complex event handlers) into custom hooks. Components should read like a description of the UI, not contain implementation details.

## API Interaction

### Query and Mutation Hooks — `lib/query/`

All tRPC queries and mutations are centralized in `lib/query/{domain}.queries.ts` files. Components never call `trpc.*` directly — they import hooks from these files.

### Queries — `useSuspenseQuery`

Prefer use `useSuspenseQuery` for data fetching, handle loading states via `<Suspense fallback={<Skeleton />}>` boundary.

```ts
// In lib/query/tests.queries.ts
export function useTests() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(
        trpc.tests.list.queryOptions({ applicationId: currentApp.id }),
    );
}

// In a component
const { data: tests } = useTests();
```

Never use `useQuery` for initial page data.

### Route Loaders — `ensureAPIQueryData`

Data that is central to rendering a page should be prefetched in the route loader using `ensureAPIQueryData`. This ensures the data is available before the component renders, which means that consumers of that data can safely use `useSuspenseQuery` without any need for `Suspense` boundaries inside the component tree.

```ts
// In a route file
export const Route = createFileRoute("/_dashboard/app/$appSlug/tests/$testId")({
    loader: async ({ context: { queryClient }, params: { testId } }) => {
        await ensureTestDetailData(queryClient, testId);
    },
    component: TestDetailPage,
});
```

### Mutations — `useAPIMutation`

All mutations use the `useAPIMutation` wrapper from `lib/query/api-queries`. It automatically shows error toasts and supports `successToast` / `errorToast` options.

Mutation hooks in `lib/query/` files:

- Do **not** accept `onSuccess` parameters — they only handle cache invalidation internally (via `onSettled`).
- Consumer-specific side effects (closing dialogs, navigation) go in `mutate()`'s second argument.

```ts
// In lib/query/tests.queries.ts — no onSuccess param
export function useRenameTest(testId: string) {
    const queryClient = useQueryClient();
    return useAPIMutation(
        trpc.tests.rename.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.tests.detail.queryKey({ testId }),
                });
                void queryClient.invalidateQueries({
                    queryKey: trpc.tests.list.queryKey(),
                });
            },
        }),
    );
}

// In a component — consumer handles UI side effects
const renameTest = useRenameTest(testId);
renameTest.mutate(
    { testId, name },
    {
        onSuccess: () => {
            onOpenChange(false);
        },
    },
);
```

### Adding a New Query or Mutation

1. Add the hook to the appropriate `lib/query/{domain}.queries.ts` file.
2. For queries: use `useSuspenseQuery` with `trpc.{router}.{procedure}.queryOptions(...)`.
3. For mutations: use `useAPIMutation` with `trpc.{router}.{procedure}.mutationOptions(...)`. Invalidate related queries in `onSettled`.
4. If the query is needed in a route loader, also export a plain `queryOptions` function.

### tRPC Proxy

The tRPC proxy is a plain import from `lib/trpc` — not a hook. It uses `createTRPCOptionsProxy` and is available everywhere, including non-component code like route loaders.

```ts
import { trpc } from "lib/trpc";
```

### Data Fetching — Suspense + Skeleton

**Every component that fetches data must have a Suspense boundary with a skeleton fallback.** This is non-negotiable for all new UI.

- Always wrap data-fetching components in `<Suspense fallback={<YourSkeleton />}>`.
- Use `Skeleton` from `@autonoma/blacklight` to build skeleton fallbacks that mirror the shape of the final UI.
- Export a named skeleton component alongside the data-fetching component (e.g., `MySection` + `MySectionSkeleton`).
- Skeletons should match the layout of the real content - same heights, widths, and spacing - so there is no layout shift when data loads.
- For pages with multiple independent data sections, use separate Suspense boundaries per section so they can load independently.
- For dialogs that fetch data, wrap the dialog content in a Suspense boundary inside the dialog.
- Route loaders with `ensureAPIQueryData` prefetch data, but still add Suspense boundaries as a safety net.

```tsx
// GOOD - co-located skeleton + component
export function MetricsSection() {
  const { data } = useMetrics();
  return <div>...</div>;
}

export function MetricsSectionSkeleton() {
  return (
    <div className="flex gap-4">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

// Usage in parent
<Suspense fallback={<MetricsSectionSkeleton />}>
  <MetricsSection />
</Suspense>
```

## Analytics

PostHog tracking is fully centralized:

- **`MutationCache` / `QueryCache`** in `lib/trpc.ts` — auto-tracks all tRPC mutations and query errors
- **PostHog autocapture** — clicks, pageviews, form submissions

Only these files should import `posthog-js`: `main.tsx`, `lib/trpc.ts`, `__root.tsx`.

## Design System Rules

### No Hardcoded Pixels in Tailwind

Never use arbitrary pixel values like `text-[10px]`, `size-[14px]`, `h-[18px]`. Always use Tailwind scale classes or custom theme tokens.

```tsx
// GOOD
<div className="text-3xs size-4 h-8" />

// BAD - hardcoded pixels
<div className="text-[10px] size-[14px] h-[18px]" />
```

**Acceptable exceptions:**
- `rounded-[inherit]` - CSS inherit value
- `transition-[color,box-shadow]` - CSS property list
- `shadow-[...]` and `[clip-path:...]` - complex CSS values with no Tailwind equivalent

### Custom Font Sizes

Below `text-xs` (12px), use theme tokens defined in `@autonoma/blacklight`:

| Token | Size | Usage |
|-------|------|-------|
| `text-4xs` | 9px | Tiny labels, metadata |
| `text-3xs` | 10px | Section meta, stat values |
| `text-2xs` | 11px | Section headers, descriptions |

### Semantic Color Tokens

Use semantic color tokens from the theme, not raw colors:

- **Surfaces:** `bg-surface-void`, `bg-surface-base`, `bg-surface-raised`, `bg-card`
- **Text:** `text-text-primary`, `text-text-secondary`, `text-foreground`
- **Borders:** `border-border-dim`, `border-border-mid`, `border-border-highlight`
- **Accent:** `text-primary`, `bg-primary`, `border-primary`
- **Status:** `text-status-success`, `text-status-critical`, `text-status-high`, `text-status-warn`

**Do not use `text-text-tertiary`.** This token is deprecated and no longer available. Use `text-text-secondary` as the lightest text tone instead. This applies to all new and edited UI code.

### Icons - Phosphor Icons

Use `@phosphor-icons/react` for all icons. **Import individually** with the `Icon` postfix to avoid barrel export performance issues:

```tsx
// GOOD - individual imports with Icon postfix
import { PlayIcon } from "@phosphor-icons/react/Play";
import { BugIcon } from "@phosphor-icons/react/Bug";

// BAD - barrel import
import { PlayIcon, BugIcon } from "@phosphor-icons/react";

// BAD - missing Icon postfix
import { Play } from "@phosphor-icons/react/Play";
```

Type for icon components: `import type { Icon } from "@phosphor-icons/react/lib";`

Available weights: `thin`, `light`, `regular`, `bold`, `fill`, `duotone`

### Fonts

Two font families only:
- `font-sans` (DM Sans) - headings, body copy, UI elements
- `font-mono` (Geist Mono) - code, metadata labels, technical data

### Component Library

Always use `@autonoma/blacklight` components. Key components and their variants:

- **Button** - variants: `default`, `accent`, `cta`, `outline`, `secondary`, `ghost`, `destructive`, `link`. Sizes: `default`, `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`
- **Card** - variants: `default`, `glass`, `stat`, `raised`. Sizes: `default`, `sm`, `compact`. Sub-components: `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`, `CardLabel`, `CardValue`, `CardMeta`
- **Badge** - variants: `default`, `secondary`, `destructive`, `outline`, `ghost`, `critical`, `high`, `warn`, `success`, `status-passed`, `status-failed`, `status-running`, `status-pending`
- **Progress**, **Tabs**, **Separator**, **Skeleton** - see blacklight source for API
