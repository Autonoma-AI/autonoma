import type { AppRouter } from "@autonoma/api/router";
import type { Operation } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";

/** Every `router.procedure` path in the API, so the set below cannot name one that does not exist. */
type ProcedurePath = {
    [TRouter in keyof inferRouterOutputs<AppRouter>]: `${TRouter & string}.${keyof inferRouterOutputs<AppRouter>[TRouter] & string}`;
}[keyof inferRouterOutputs<AppRouter>];

/**
 * Queries the app shell reads on every page.
 *
 * `httpBatchLink` groups whatever React dispatches in one tick and a batch resolves only when its
 * SLOWEST member does, so a shell query that lands in a page's batch paints at that page's speed.
 * Making these procedures cheap does not help: the batch is one response payload, so a 5ms member
 * still waits on a 5s neighbour. Cost and coupling are separate problems; this addresses coupling.
 *
 * Listed by procedure rather than set per call site because this is a property of the query, not of
 * who is asking - and because a shared key cannot be routed per call site at all: React Query
 * dedupes by query key, so whichever observer mounted first would silently decide for every other.
 *
 * This list is not maintained by hand against the shell. `lib/query/app-shell.queries.ts` declares
 * the shell's reads keyed by procedure and asserts `satisfies Record<ShellWideProcedure, ...>`, so a
 * member here without a reader - or a reader whose procedure is not a member - does not compile.
 *
 * Deliberately absent:
 * - `auth.orgStatus` is read only in the app-shell `beforeLoad`, where riding one batched request
 *   with `applications.list` is the point, and nothing observes it after the loader resolves.
 * - `billing.status` and `onboarding.getState` are no longer shell reads - the sidebar takes
 *   `billing.subscriptionStatus` and `onboarding.navState` instead.
 *
 * Mutations are absent by nature, not by exception: a batch's cost is a shared response payload, and
 * a mutation fires from a click rather than alongside a page's render.
 */
const SHELL_WIDE_PROCEDURES = [
    "applications.suiteHealth",
    // Only read inside an open dialog, but "open" is not isolated - opening it while a page's own
    // queries are in flight would batch this with them, and it is the heavier query (for an app whose
    // runs never reach the Reporter it falls back to scanning findings), so it would be the member
    // everything else waited on.
    "applications.suiteHealthFixPlan",
    // Read in the loader, but ALSO observed at render time by three shell-mounted components -
    // `DemoBanner`, `DemoReturnButton`, and `ConnectAgentDialog`, which calls it above its own
    // dialog and so fetches on every page whether or not the dialog is opened. Leaving it batched
    // meant a window refocus past the 30s staleTime could refetch it inside a page's batch.
    "auth.activeOrg",
    "billing.subscriptionStatus",
    "onboarding.navState",
    "organization.mine",
] as const satisfies readonly ProcedurePath[];

/** A procedure the app shell reads, so `app-shell.queries.ts` can be checked against this list. */
export type ShellWideProcedure = (typeof SHELL_WIDE_PROCEDURES)[number];

const SHELL_WIDE: ReadonlySet<string> = new Set(SHELL_WIDE_PROCEDURES);

/**
 * Whether an operation should bypass the HTTP batch, i.e. the `condition` of the `splitLink` in
 * {@link file://./trpc.ts}. A pure function of the operation, so it is testable without a browser.
 *
 * `FormData` cannot be batched at all - a batch serialises its members' inputs into the query string.
 */
export function shouldSkipBatch(op: Pick<Operation, "path" | "input">): boolean {
    return op.input instanceof FormData || SHELL_WIDE.has(op.path);
}
