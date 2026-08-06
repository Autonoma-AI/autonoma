# Loading and error states: screen-by-screen survey

**Everything below has been implemented.** This stays as the evidence trail: the measurements, and the
reasoning that decided the fix. Read the per-screen table and the issue list as *what was true before* -
the "waiting" column in particular describes the state this work removed, and is the regression baseline
the `Waiting/Screens` stories now guard.

Measured on `IgnacioPardo/chore-loading-state-survey`, branched from `origin/main` at `bd5a949f9`.

## What was done

| # | Issue | Outcome |
|---|---|---|
| 1 | Router `defaultPendingComponent` + `defaultErrorComponent` | Done, plus `defaultOnCatch` for Sentry. `RoutePendingSkeleton` and `RouteErrorState` in `src/components/`, mirrored into `lib/storybook/page-story.tsx`, `RouterProvider` wrapped in `QueryErrorResetBoundary`. This is the fix; the rest is shaping. |
| 2 | Pending state for `app.$appSlug/route.tsx` | **Collapsed into #1.** That route renders inside `_app-shell`'s already-mounted component, so the default shows in the content well with the sidebar up. What did need its own is `_app-shell/route.tsx`, where the real `Sidebar` cannot render yet: `AppShellSkeleton`, sharing the grid track via `sidebarGridTemplate`. |
| 3 | `fetchQuery` -> `ensureQueryData` in the shell | **Not done - the survey was wrong.** See the corrected entry in the issue list. It resolved to a comment. |
| 4 | Home | `pendingComponent` with the real header over the two exported panel skeletons; the bare `m-6 flex-1` block is gone. |
| 5 | PR detail | `pendingComponent` on the tabs layout and the Overview tab; `ensureAnalysisIssuesData` hoisted a stage earlier, so the chain is 2 round trips rather than 3. |
| 6 | `/billing/` had no Suspense boundary | **Handed to #2130** (settings redesign), which rebuilds Billing as an org-level destination with its own `-billing-skeleton.tsx`. |
| 7 | PR Preview tab | Two independent awaits parallelised (2 round trips to 1) and `PreviewPageSkeleton` wired as the pending state. |
| 8 | `__root.tsx` first paint | Now the neutral skeleton rather than a centred `Loading…` text node. |
| 9 | Skeletons invisible on raised panels | **Handed to #2130**, which carries the `--skeleton` token and the `Skeleton` change. Diagnosis and evidence below stand. |
| 10 | Main branch | `pendingComponent` over the real header. The `fallback={null}` **stays null** - that section renders nothing for an app without previewkit - and the skeleton moved inside it. |
| 11 | Tests, Scenarios, History | Tests done. Scenarios and History are Settings tabs and went to **#2130**, which moves both. |
| 12 | `preview-config`'s `fallback={undefined}` | Fixed at the shared `AddAppDialog` - the frame paints immediately, the repo picker suspends inside it - which fixes the onboarding call site too. The `preview-config` route itself went to **#2130**. |
| 13 | Consolidate 57 skeletons | `TableSkeleton` promoted to `@autonoma/blacklight`, 4 copies retired (History's is #2130's). The two `PageSkeleton`s and two `ContentSkeleton`s were **left alone** - they share a name, not a shape. |
| 14 | `generation-progress`'s loader-less `pendingComponent` | Commented: it is the Suspense fallback the router wraps the component in. |
| 15 | `storybook:shoot` cannot photograph a loading state | `--wait-until` added; `--settle-ms` already covered "capture after", so no second flag. Documented in the `ui-screenshots` skill. |

Two things worth carrying forward, both visible in the re-shot stories:

- **A cold landing shows the generic default, not the page's own skeleton.** The app layout's
  `branches.detailByName` shares an HTTP batch with the landing page's first query, so the layout cannot
  resolve first and its pending state covers the whole wait. The per-route skeletons appear on warm
  navigation, which `HomeWarm` and `PullRequestsWarm` exist to prove. Unbatching the layout query would
  change that - a genuine follow-up for A4's territory, not this work.
- The remaining 22 `pnpm lint` warnings are pre-existing and untouched.

**Settings is out of scope here.** #2130 rebuilds Settings end to end - four destinations, a section rail,
and its own skeletons and empty states - so issues 6, 9 and the Settings half of 11, plus the
`preview-config` route and the `--skeleton` token, are its work rather than this PR's. Rows 7, 11, 12, 14
and 17-20 of the per-screen table below, and the `Settings /` lines in the issue list, are therefore a
baseline for #2130 to close, not a record of what this PR changed.

## The headline

The app has 7 `pendingComponent`s across 70 routes, and the shape reads that as "63 screens are missing a
skeleton". It is not that. **One route decides the waiting state of every app screen**, and it has no
`pendingComponent`:

```ts
// routes/_blacklight/_app-shell/app.$appSlug/route.tsx
loader: ({ context, params: { appSlug } }) => {
  const app = context.applications.find((a) => a.slug === appSlug);
  if (app == null) throw notFound();
  setLastApp(app.slug);
  return ensureBranchData(context.queryClient, app.id, app.mainBranch.name);   // <- one query
},
```

That is the layout above `/app/$appSlug/**` - 44 route files, every customer screen in the product. While
its single `branches.detailByName` call is outstanding, **the entire application is blank: page, sidebar,
org name, everything.**

The mechanism, from the router itself (`@tanstack/react-router@1.161.1`, `dist/esm/Match.js:48`):

```js
const ResolvedSuspenseBoundary =
  (!route.isRoot || route.options.wrapInSuspense || resolvedNoSsr) &&
  (route.options.wrapInSuspense ?? PendingComponent ?? (...))
    ? React.Suspense : SafeFragment;
```

A route with no `pendingComponent` is **not wrapped in a Suspense boundary at all**. Its wait does not
stay local - it escapes upward, and the only boundary above it is the root `Outlet`'s
`<Suspense fallback={pendingElement}>`, where `pendingElement` is `defaultPendingComponent` - which
`main.tsx` never sets. So the fallback is `null` and the whole tree unmounts to nothing.

The same absence governs errors. `createRouter` sets no `defaultErrorComponent` and `__root.tsx` declares
no `errorComponent`, so `ResolvedCatchBoundary` is also `SafeFragment`: a throw from any loader without
its own `errorComponent` takes the app to a blank page rather than an error state.

The codebase already knows the symptom and treats it downstream, in `lib/trpc.ts:26`:

```ts
// 30 s stale time prevents loaders from re-blocking on cache hits
// and eliminates the "blank screen flash" during navigation
staleTime: 30_000,
```

That comment is the workaround for exactly this, and it is worth being precise about how far it goes,
because it decides which of the screens below actually hurt:

- **Cold load** - a hard refresh, or the link out of a GitHub PR comment, which is how customers arrive.
  Nothing is cached, so the shell's 4-stage `beforeLoad`, the layout's branch query and the page's own
  chain all run, and the screen is blank for the whole of it. This is the case that matters.
- **Navigation within 30 s** - everything is fresh, loaders return from cache, no visible wait.
- **Navigation after 30 s idle** - one query re-blocks, and only one. `_app-shell/route.tsx:43` reads
  `applications.list` with `queryClient.fetchQuery`, which awaits a real fetch whenever the data is stale
  (`query-core`: `isStaleByTime(...) ? query.fetch(...) : Promise.resolve(cached)`). Its three siblings -
  session, organizations, `orgStatus` - all use `ensureQueryData`, which returns cached data immediately
  however stale (`revalidateIfStale` is not set anywhere in `src`). So does `ensureBranchData`. Read a PR
  for a minute, click anything, and the screen blanks for one round trip because of that single
  `fetchQuery`.

That last one is a one-word fix, and it is in the list below.

**Consequence for the ordering of this shape:** two lines in `main.tsx` change the waiting state of every
screen in the table below. Doing them first makes every later per-screen issue a matter of *shaping* a
skeleton rather than *introducing* one.

## What was measured, and how

Three passes. All of it is reproducible; the harness is in `src/stories/waiting-screens.stories.tsx` plus
the two drivers quoted at the end.

1. **Static sweep** of all 70 `createFileRoute` files: loader shape, serial `await` depth,
   `pendingComponent`, `errorComponent`, Suspense boundaries and their fallbacks.
2. **Waiting state, seen** - `Waiting/Screens` stories render real routes through the real route tree and
   leave one procedure permanently unanswered, so a screenshot catches the state a customer sits in front
   of. A stalled procedure needs no fixture, which is what makes this cheap.
3. **Render vs query** - every `Pages/*` story timed with MSW answering instantly (3 runs, median).

**Round-trip cost.** `api.autonoma.app` answers in ~160 ms on a warm connection from a developer machine
(measured: 476 ms first request including TCP + TLS, then 159/191/159/163 ms). So one serial stage in a
loader chain is a ~160 ms floor plus that procedure's server time. A 3-stage chain is a ~0.5 s floor of
blank screen before the server has done any work.

**Not measured: real traffic.** The issue suggests crossing this with usage, and the PostHog connector is
not authorized in this session. Priorities below therefore use a stated proxy - the product's own entry
path - and ranking the top of the list against PostHog is a cheap follow-up for whoever has access. It is
unlikely to reorder P0/P1: those are the screens the GitHub PR comment links into.

### Render is not the problem, anywhere

With zero network latency, every screen paints in 357-443 ms and settles by 780 ms, flat across a 5x
spread in DOM size:

| Story | first paint | settled | DOM nodes |
|---|---|---|---|
| `pages-apphome--default` | 443 ms | 482 ms | 121 |
| `pages-apphome--many-pull-requests` | 442 ms | 498 ms | 405 |
| `pages-pullrequests--single-page` | 394 ms | 733 ms | 198 |
| `pages-pullrequests--many-pull-requests` | 405 ms | 769 ms | 593 |
| `pages-authoritativeprpage--report` | 439 ms | 481 ms | 211 |
| `pages-prpreviewtab--ready` | 417 ms | 778 ms | 243 |
| `pages-authoritativesnapshotpage--report` | 432 ms | 483 ms | 197 |
| `pages-mainbranchpage--default` | 378 ms | 737 ms | 202 |
| `pages-previewenvironments--default` | 396 ms | 434 ms | 203 |
| `pages-previewconfigpage--variables` | 363 ms | 743 ms | 268 |
| `pages-analysistriggers--default` | 386 ms | 722 ms | 226 |
| `pages-finishsetupsdk--artifacts-step` | 357 ms | 740 ms | 149 |
| Settings / General (a fetch-free screen, measured as a floor) | 367 ms | 405 ms | 214 |

The ~380 ms floor is the Storybook dev harness booting modules, not the screens - which is the point: it
is the same for a 121-node page and a 593-node page. **Every screen in this app is query-bound.** Nothing
here needs virtualisation, memoisation or a lighter render. That closes the issue's "cuáles tardan por la
query y no por el render" question: all of them, by the query.

## Per-screen table

`stages` is the number of serial round trips the screen's own loader chain needs, on top of the layout's.
`waiting` is what is on screen during them, observed rather than inferred.

| # | Screen | Route file | stages | pending | error | waiting | priority |
|---|---|---|---|---|---|---|---|
| 1 | **App layout** (all app screens) | `app.$appSlug/route.tsx` | 1 | no | no | **nothing - whole app, sidebar included** | **P0** |
| 2 | **App shell** (auth gate) | `_app-shell/route.tsx` | 4 (`beforeLoad`) | no | no | **nothing** | **P0** |
| 3 | First paint after load | `__root.tsx:89` | - | - | - | centred `Loading…` text node | P2 |
| 4 | **Home** | `app.$appSlug/index.tsx` | 1 (`Promise.all` x3) | no | no | **nothing**; inner fallback is `<Skeleton className="m-6 flex-1"/>` | **P1** |
| 5 | **PR detail / Overview** | `$prNumber/_tabs/route.tsx` + `_tabs/index.tsx` | 2 + 3 | no | no | **nothing** - deepest chain in the app | **P1** |
| 6 | **PR / Preview tab** | `$prNumber/_tabs/preview.tsx` | 2 (**1 is avoidable**) | no | no | **nothing**, then the log panel's spinner | **P1** |
| 7 | **Settings / Billing** | `billing/index.tsx` | 0 | no | no | **nothing** - no Suspense boundary anywhere on the route | **P1** |
| 8 | PR list | `pull-requests/index.tsx` | 1 | **yes** | no | shaped skeleton when warm; nothing when cold (see below) | P2 |
| 9 | Main branch | `pull-requests/main.tsx` | 2 | no | no | nothing; then `MainBranchSkeleton`, and `<Suspense fallback={null}>` at L76 | P2 |
| 10 | Tests | `tests/route.tsx` | 1 | no | no | nothing; then a skeleton that is **invisible** (see below) | P2 |
| 11 | Settings / Scenarios | `scenarios/index.tsx` | 1 | no | no | nothing; then `ContentSkeleton` | P2 |
| 12 | Settings / History | `history/index.tsx` | 2 | no | no | nothing; then `TableSkeleton` | P3 |
| 13 | PR / Suite tab | `$prNumber/suite.tsx` | 2 | no | no | nothing; then `PageSkeleton` | P3 |
| 14 | Settings / Preview Environments | `preview-config/{route,index}.tsx` | 0 | no | no | `PreviewConfigSkeleton`; but `<Suspense fallback={undefined}>` at `index.tsx:51` | P3 |
| 15 | Finish setup | `finish-setup/index.tsx` | 1 | no | no | nothing; then `<Skeleton className="h-96 w-full"/>`, plus 6 spinners | P3 |
| 16 | PR snapshot report | `snapshots/$snapshotId/route.tsx` | 1 (`Promise.all` x5, deliberate) | no | children only | nothing; then `PageSkeleton` | P3 |
| 17 | Settings / General | `settings/index.tsx` | 0 | no | no | instant - fetches nothing | P4 (fixed by #1) |
| 18 | Settings / GitHub | `github/index.tsx` | 0 | no | no | `GitHubSettingsSkeleton` | P4 |
| 19 | Settings / API Keys | `api-keys/index.tsx` | 0 | no | no | Suspense inside the panel | P4 |
| 20 | Settings / Triggers | `analysis-triggers/index.tsx` | 1 | no | no | `AnalysisTriggersSkeleton` | P4 |
| 21 | Test detail | `tests/$testSlug.tsx` | 1 | **yes** | no | `TestDetailSkeleton` | P4 |
| 22 | Issue / bug detail | `issues/$issueId.tsx`, `bugs/$bugId.tsx` | 1 | yes / no | no | skeleton | P4 |
| 23 | Preview Environments page | `preview-environments/index.tsx` | 1 | **yes** | no | `PreviewEnvironmentsPageSkeleton` | n/a - **B2 deletes it** |

Rows 1-7 are where the work is. Rows 17-22 are already fine or become fine once #1 lands.

### Why the 7 `pendingComponent`s buy less than they look like

The PR list has a `pendingComponent`, and on a cold navigation it never renders. The layout's
`branches.detailByName` and the page's `branches.list` are issued in the same tick, so `httpBatchLink`
coalesces them into **one** request - measured:

```
trpc/branches.detailByName,branches.list,branches.mainOpenProblems,onboarding.getState?batch=1
```

The parent therefore cannot finish before the child. There is no window in which the parent has resolved
and the child is still pending, so the parent's blank covers the child's skeleton for the whole wait. It
appears only on a **warm** navigation, when the layout's branch query is already cached - which the two
screenshots below show side by side.

This is why #1 and #2 are P0 and everything else is P1 or lower: until the layout has a pending state,
adding per-route ones changes nothing a customer can see on the path they actually arrive by (a link from
a GitHub PR comment - a cold load).

### Two avoidable round trips

Both are on the PR path, and both are ordinary `CLAUDE.md` "parallelize independent awaits" work:

**`$prNumber/_tabs/preview.tsx`** - a genuine violation. The second await does not depend on the first;
`ensurePreviewEnvironmentSummaryData(queryClient, applicationId, prNumber)` needs only values that were
available before the first call:

```ts
await ensureBranchByPrData(context.queryClient, app.id, prNumber);
await ensurePreviewEnvironmentSummaryData(context.queryClient, app.id, prNumber);   // independent
```

**`$prNumber/_tabs/index.tsx`** - a 3-stage chain whose last stage contains one call that only needs
`branch.id`, known after stage 1. Hoisting `ensureAnalysisIssuesData` into stage 2 takes the Overview tab
from 3 stages to 2:

```ts
const branch = await ensureBranchByPrData(...);              // stage 1 -> branch.id
const snapshots = await ensureSnapshotHistoryData(branch.id); // stage 2
await Promise.all([
  ensureAnalysisJobData(latest.id),                           // stage 3, needs latest.id
  ensureAnalysisReportData(latest.id),                        // stage 3, needs latest.id
  ensureAnalysisIssuesData(branch.id),                        // <- only needs branch.id
]);
```

Do **not** "fix" `snapshots/$snapshotId/route.tsx`: its five-call `Promise.all` carries a comment saying
they are all keyed by `snapshotId` so `httpBatchLink` coalesces them into one request. That is a
load-bearing invariant. Same for `pull-requests/main.tsx` and `_tabs/route.tsx`, whose sequencing is a
real data dependency (they need `branch.id`).

### Skeletons that are invisible

`Skeleton` is `bg-surface-raised`, and `--surface-raised` is `#222222`
(`packages/blacklight/src/components/ui/skeleton.tsx`, `packages/blacklight/src/index.css:55`). The
standard raised container is also `bg-surface-raised`. A skeleton placed directly inside one is drawn in
its own background colour.

`tests/route.tsx:115` is exactly that: a `bg-surface-raised` panel wrapping `TreePanelSkeleton`, whose
four bars are `bg-surface-raised`. The code looks like a well-shaped skeleton - four indented lines
suggesting a tree - and on screen it is a featureless grey rectangle. The screenshot below is that panel
with all four skeleton nodes present in the DOM.

The PR list's skeletons are fine by contrast: `#222222` on `#1A1A1A` (probed computed styles), which
reads. So this is a placement rule, not a broken primitive - but it is a rule nothing enforces, and the
fix belongs at the primitive (a dedicated skeleton token that differs from every surface) rather than in
each of 57 call sites.

### Skeleton and spinner inventory

**57 skeleton components** are defined across `apps/ui` (50 distinct names) over one 9-line primitive.
The duplicates are the consolidation candidates:

- `TableSkeleton` x5 - `admin/issues`, `admin/previewkit`, `admin/generations`, `history`, `preview-environments`
- `ContentSkeleton` x2 - `pull-requests/index`, `scenarios`
- `PageSkeleton` x2 - `snapshots/$snapshotId/route`, `$prNumber/suite`

A shared `TableSkeleton` in `@autonoma/blacklight` taking a column count retires five of them, and
`SortableTable` is already there to key it off.

**11 `animate-spin` sites in 5 files.** Most are correct usage - a button's pending state:

| File | sites | kind |
|---|---|---|
| `finish-setup/index.tsx` | 6 | 5 button-pending, 1 page-level (L1928) |
| `components/build-logs/preview-logs-tabs.tsx` | 2 | panel-level, A2's target |
| `components/build-logs/build-log-stream-viewer.tsx` | 1 | `EmptyState` spinner on zero entries - A2's target |
| `components/analysis/analysis-job-status.tsx` | 1 | page-level, but with a `Analyzing` badge and explanatory copy |
| `pull-requests/-components/pr-page-header.tsx` | 1 | button-pending ("Starting...") - correct |

Two corrections to the plan's static list here: `pr-page-header.tsx`'s spinner is a mutation-pending
indicator inside a button, not a page wait, and `-app-not-found.tsx`'s `BrailleSpinner` ships with real
copy ("Looking for this in your other organizations...", "Switching to Acme..."), which is what a spinner
should do. Neither is a skeleton candidate.

## Error states

7 `errorComponent` declarations exist, and the plan's "none on a main customer route" is too strong - 4 of
the 7 are on customer routes, just never on a top-level surface:

| Route | errorComponent |
|---|---|
| `analysis/issues/$issueId.tsx` | `AnalysisIssueErrorState` |
| `$prNumber/issues/$issueId.tsx` | `AnalysisIssueErrorState` |
| `$prNumber/snapshots/$snapshotId/findings/route.tsx` | `FindingErrorState` |
| `$prNumber/snapshots/$snapshotId/investigation/route.tsx` | `InvestigationErrorState` |
| `preview-waiting.tsx` | `PreviewWaitingError` |
| `preview-auth.tsx` | inline `ErrorPage` |
| `admin/index.tsx:209` | inline JSX prop |

Plus 4 hand-rolled class boundaries: `-layout/sidebar-suite-health.tsx` (the worked example, and its
comment states the reasoning - the sidebar renders on every page, so an unguarded throw from the
suite-health poll takes the shell down), `preview/environment-summary-strip.tsx`, `onboarding/add-app.tsx`,
`onboarding/route.tsx`.

Everything else - Home, the PR list, PR detail, every tab, all of Settings - has no error handling, and
because the root has none either the failure mode is a blank page with no message and no way back. That
is one `defaultErrorComponent` away from being an error state on every screen at once.

Note that proving this visually needs a story that deliberately errors, and `storybook:shoot` is built to
**reject** those (it exits 1 on an unmocked procedure so screenshots never show error states). Whoever
takes the `defaultErrorComponent` issue will need to shoot it another way - see the last finding below.

## Handoff to A4 (tRPC batching)

Measured, not inferred - the batches each screen actually issues:

- **`billing.status` is fetched on every screen in the app.** `-layout/sidebar.tsx:146` reads it with a
  plain `useQuery` for the upgrade button, and it lands in the same HTTP batch as the page's own queries
  on all 10 screens measured. It is the clearest candidate for `UNBATCHED`, exactly like
  `suite-health.queries.ts` already does.
- Wave 2 on nearly every screen is `billing.status, onboarding.getState, auth.activeOrg,
  previewAccess.livenessForApplication` coalesced with page data - four shell-level queries riding with
  the content.
- The layout's `branches.detailByName` batches with each page's first queries (shown above), which is what
  defeats the per-route `pendingComponent`s. Worth A4 knowing: unbatching the layout query would let the
  PR list's existing skeleton appear on cold loads too.
- A4's own note that the `useSnapshotDetails` fan-out (`_tabs/index.tsx:444`) is the only
  `useSuspenseQueries` in the app is confirmed - it is the sole `useQueries`/`useSuspenseQueries` call site.

If A4's measurements disagree with the render/query split above, trust A4: this survey timed a dev-mode
Storybook against MSW, not production against Postgres.

## The issue list

In dispatch order. Each is one PR.

**P0 - one change each, whole-app effect**

1. **Give the router a `defaultPendingComponent` and a `defaultErrorComponent`.** `main.tsx:94`, mirrored
   into `lib/storybook/page-story.tsx:22` or no story will show it. Converts every "nothing" in the table
   into a shell plus a skeleton, and every uncaught loader throw into an error state. Blocked on nothing.
2. **Give `app.$appSlug/route.tsx` a pending state.** It is the layout above every app screen and its one
   `branches.detailByName` call currently blanks the sidebar. A route-level component reads better here
   than the generic default.
3. ~~**`_app-shell/route.tsx:43`: `fetchQuery` -> `ensureQueryData` for `applications.list`.**~~
   **This was wrong, and the check it asked for is why.** The refetch **is** load-bearing, and not for org
   switching - both live switch paths (`admin/index.tsx:253`, `-app-not-found.tsx:49`/`:64`) use
   `router.navigate({ reloadDocument: true })`, which discards the whole QueryClient, and the one path that
   did rely on it (`components/org-switcher.tsx`) is dead code with no importer.

   It is load-bearing for **application create/delete/rename**. Nothing observes `applications.list` inside
   the shell: `context.applications` comes from `beforeLoad`, every consumer reads it through
   `useRouteContext`, and the `useApplications()` suspense query is only mounted under
   `_blacklight/onboarding`. `invalidateQueries` defaults to `refetchType: "active"`
   (`query-core@5.90.20`, `queryClient.js:149-165`), so the invalidations in `useDeleteApplication`,
   `useRenameApplication`, `useLinkRepository` and `useCompletePreviewOnboarding` only set an
   `isInvalidated` marker. `fetchQuery` is what then actually refetches, because `isStaleByTime` treats an
   invalidated query as stale; `ensureQueryData` would hand back the pre-mutation array. Deleting an app
   would leave it in the context, and `_app-shell/index.tsx:48-66` would redirect straight back into it -
   with the last app deleted, the `applications.length === 0` redirect to `/onboarding` would not fire
   either.

   So this resolved to **a comment on that line**, and the blank round trip it was chasing is fixed by #1
   anyway, since the shell match now has a boundary. Making the invalidations explicit
   (`refetchType: "all"`) so `ensureQueryData` becomes safe is a legitimate follow-up; it trades a one-RTT
   navigation win for regression risk in app deletion, which is why it is not in this change.

**P1 - the screens customers arrive on**

4. **Home**: `pendingComponent`, and replace the outer `<Skeleton className="m-6 flex-1"/>` with the shape
   the page becomes (`OpenPrsListSkeleton` and `MainProblemsRailSkeleton` already exist and are correct -
   the bare block is only the outer fallback). Coordinate with B3, which merges Home into the PR list.
5. **PR detail**: `pendingComponent` on `_tabs/route.tsx` and `_tabs/index.tsx`, and hoist
   `ensureAnalysisIssuesData` one stage earlier - 3 serial stages becomes 2.
6. **`/billing/` has no Suspense boundary at all.** `BillingPanel` opens with a `useSuspenseQuery` and the
   18-line route wrapper gives it nothing to suspend into. Coordinate with A5, which may move Billing out
   of Settings entirely.
7. **PR Preview tab**: `Promise.all` the two independent awaits in `_tabs/preview.tsx`, plus a
   `pendingComponent`. Coordinate with A2, which is rewriting what that panel shows when idle.

**P2**

8. **`__root.tsx:89` first paint** is a centred `Loading…` text node - the app's very first impression.
   Make it the shell's skeleton. (It also uses `text-text-tertiary`, which `CLAUDE.md` forbids in new code.)
9. **Skeletons are invisible on raised panels.** Give `Skeleton` a token that differs from every surface,
   then re-check the placements; `tests/route.tsx:115` is the proven case.
10. **Main branch**: `pendingComponent`, and give `main.tsx:76`'s `<Suspense fallback={null}>` the preview
   section's shape.
11. **Tests, Scenarios, History**: `pendingComponent` each. Mostly redundant once #1 lands - worth their
    own issues only if the generic default reads badly on them.

**P3**

12. `preview-config/index.tsx:51` `<Suspense fallback={undefined}>` - deliberate per its comment, but
    silent. The dialog should have a fallback.
13. **Consolidate 57 skeletons**: promote `TableSkeleton` to `@autonoma/blacklight` (retires 5), then
    `ContentSkeleton` and `PageSkeleton` (2 each).
14. `generation-progress/index.tsx` declares a `pendingComponent` with no loader. It is not dead - the
    router reuses it as the route's Suspense fallback - but that is worth a comment, since it reads as a
    mistake.
15. **`storybook:shoot` cannot photograph a loading state.** `scripts/storybook-screenshot.ts:81` navigates
    with `waitUntil: "networkidle"`, so it either captures the settled screen or times out. Every issue
    above ships a loading state that the repo's own tool cannot prove. Add `--wait-until` /
    `--capture-after-ms`. This one should land **before** the P0/P1 fixes, or they all ship unprovable.

## Corrections to the static list this survey started from

Recorded because the next agent to touch these files will otherwise re-derive them.

| Claim | What is actually true |
|---|---|
| "7 routes define `pendingComponent`" | Correct, and the 7 files match exactly. But `generation-progress/index.tsx` has one with no loader, and the PR list's is invisible on cold loads (above). |
| "7 `errorComponent` definitions, none on a main customer route" | 7 is right; 4 of them **are** on customer routes (analysis issue detail, PR issue detail, PR findings, PR investigation) - just never on a top-level surface. |
| "`app.$appSlug/index.tsx`'s skeleton is a bare block" | True of the outer fallback only. The inner boundaries use `OpenPrsListSkeleton` and `MainProblemsRailSkeleton`, which are correctly shaped. Home's problem is the missing `pendingComponent`, not that skeleton. |
| "Both 18-line Settings wrappers are equally bad" | Only Billing. `api-keys-panel.tsx:57` has its own Suspense boundary around the list. |
| "`billing-panel.tsx` is 320 lines" | 337. |
| "Loader waterfalls: `_tabs/index.tsx` 3-deep, `_tabs/preview.tsx` and `suite.tsx` 2-deep" | Depths are right, but only **`_tabs/preview.tsx`** is a `Promise.all` violation. `index.tsx` and `suite.tsx` chain on real data dependencies (`branch.id`, `latest.id`); `index.tsx` still has one call that can move a stage earlier. `main.tsx`'s 2-deep chain is also a genuine dependency. |
| "59 hand-rolled skeletons" | 57 `function *Skeleton` definitions, 50 distinct names. The x5 / x2 / x2 duplication counts are exact. |
| "6 `SpinnerGapIcon` sites in `finish-setup`" | 6 spinning sites, of which 5 are button-pending states. |
| "Page-level bare spinners incl. `-app-not-found.tsx` and `pr-page-header.tsx`" | Neither belongs on the list. `pr-page-header.tsx`'s is a mutation-pending indicator inside a button ("Starting..."); `-app-not-found.tsx`'s ships explanatory copy, which is what a spinner is for. |
| Story id `pages-pullrequests--singlepage` | It is `pages-pullrequests--single-page`. Storybook kebab-cases the export, it does not just lowercase it. |

Two things nothing in the plan had: the layout route above every screen (the headline), and the
`fetchQuery`/`ensureQueryData` asymmetry in the shell.

## Evidence

Screenshots at 1440x900 from the `Waiting/Screens` stories. The "before" column is what this work removed;
re-shooting the same story ids is the regression check.

| Story | Before | After |
|---|---|---|
| `waiting-screens--app-layout` | Pure black - the **layout's** one query outstanding while the page's own data is already answered | Sidebar and content skeleton |
| `waiting-screens--settled` | Full page (the control) | Unchanged |
| `waiting-screens--home-warm` | n/a | Real header, real rail copy, skeleton rows |
| `waiting-screens--pull-requests-warm` | Shaped list skeleton (the one good case) | Unchanged |
| `waiting-screens--tests` | Tree panel with four skeleton bars in the DOM and none visible - `#222222` on `#222222` | The bars render; full contrast lands with #2130's `--skeleton` token |
| `--home` / `--pull-requests` / `--pr-detail` / `--pr-preview-tab` | Black | Sidebar plus the layout's content skeleton (cold landing - see the batching note at the top) |
| `--app-layout-failed` / `--home-failed` | Blank page, no message, no way back | Contained retry inside a live shell |

The Settings screens this survey measured (Billing, History, Scenarios, Preview Environments) had their
stories removed with the code: #2130 moves those routes, and it carries its own
`settings-skeletons.stories.tsx`.

## Reproducing this

Stories: `src/stories/waiting-screens.stories.tsx` (`Waiting/Screens`). Each export holds one screen still
by stalling the procedure it waits on, or failing it. Neither needs a fixture.

```bash
pnpm --filter @autonoma/ui storybook
pnpm --filter @autonoma/ui storybook:shoot -- --wait-until domcontentloaded --settle-ms 4000 \
  --story waiting-screens--app-layout --story waiting-screens--home-warm
```

`--wait-until` exists because of finding #15: the default `networkidle` cannot photograph a screen that is
still waiting, and times out instead.

The render/query timings came from a `page.evaluate` loop recording the first non-empty paint of
`#storybook-root` and the point where its node count stops changing for 400 ms, median of 3 runs per story,
with MSW answering instantly. One trap if you rebuild it: pass the probe to `page.evaluate` as a **string**,
not a function - `tsx` compiles named arrows with a `__name` helper that does not exist in the page.

One trap worth writing down: pass that probe to `page.evaluate` as a **string**, not a function. `tsx`
compiles named arrow functions with a `__name` helper that does not exist inside the page, so a function
form fails with `ReferenceError: __name is not defined`.
