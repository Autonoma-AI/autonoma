import { type QueryClient, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "lib/trpc";
import type { ShellWideProcedure } from "lib/trpc-batching";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

/**
 * Suite health only moves when an analysis run finishes, which is minutes apart at best - so this
 * refetches on a slow interval rather than a live one, and only while the tab is focused.
 */
const SUITE_HEALTH_REFETCH_MS = 60_000;

/** Poll while setup is unfinished, so the nav entry disappears without the user touching the tab. */
const NAV_STATE_POLL_MS = 5000;

/** A shell read: whatever inputs it needs, answering with tRPC query options. */
type ShellRead = (...args: never[]) => { trpc: { path: string } };

/**
 * Every server read the app shell makes, keyed by the procedure it reads.
 *
 * The key is the mechanism, not decoration. `satisfies Record<ShellWideProcedure, ShellRead>` makes
 * it a compile error to add a read whose procedure is not routed out of the page batch, and to
 * register a procedure that nothing here reads - so a shell read cannot reach the wire unregistered.
 *
 * The limits, stated rather than left to be discovered. Nothing forces a shell file to take its reads
 * from here rather than straight from a domain query module, so that remains a review question. And
 * the shell mounts components it SHARES with pages (`ConnectAgentDialog`, `DemoReturnButton`) whose
 * reads are covered only by being registered here - `auth.activeOrg` is the one that matters today.
 */
const SHELL_READS = {
    "applications.suiteHealth": (applicationId: string) =>
        trpc.applications.suiteHealth.queryOptions({ applicationId }),
    "applications.suiteHealthFixPlan": (applicationId: string) =>
        trpc.applications.suiteHealthFixPlan.queryOptions({ applicationId }),
    "auth.activeOrg": () => trpc.auth.activeOrg.queryOptions(),
    "billing.subscriptionStatus": () => trpc.billing.subscriptionStatus.queryOptions(),
    "onboarding.navState": (applicationId: string) => trpc.onboarding.navState.queryOptions({ applicationId }),
    "organization.mine": () => trpc.organization.mine.queryOptions(),
} satisfies Record<ShellWideProcedure, ShellRead>;

/**
 * The suite-health meter. Suspends, so its call site owns a boundary - a cache miss must blank the
 * meter's slot, never the chrome around it.
 */
export function useShellSuiteHealth() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery({
        ...SHELL_READS["applications.suiteHealth"](currentApp.id),
        refetchInterval: SUITE_HEALTH_REFETCH_MS,
    });
}

/**
 * Warms the meter from an app route loader. Fire-and-forget rather than an `ensure*`: the meter is
 * sidebar furniture and must never hold up the page, and {@link useShellSuiteHealth} resolves from
 * the fetch this starts.
 */
export function prefetchShellSuiteHealth(queryClient: QueryClient, applicationId: string): void {
    void queryClient.prefetchQuery(SHELL_READS["applications.suiteHealth"](applicationId));
}

/**
 * Whether Finish setup is still outstanding. Polled because what flips it happens in a terminal, so
 * the nav entry has to disappear without the user touching the tab.
 */
export function useShellNavState(applicationId: string) {
    return useQuery({
        ...SHELL_READS["onboarding.navState"](applicationId),
        enabled: applicationId.length > 0,
        refetchInterval: (query) => (query.state.data?.setupComplete === true ? false : NAV_STATE_POLL_MS),
        refetchIntervalInBackground: true,
    });
}

/** Warms the nav read from the app route loader. Fire-and-forget, for the same reason as the meter. */
export function prefetchShellNavState(queryClient: QueryClient, applicationId: string): void {
    void queryClient.prefetchQuery(SHELL_READS["onboarding.navState"](applicationId));
}

/**
 * Whether the organization is subscribed. Plain `useQuery`: this decides whether to offer an action,
 * and suspending the shell on it would blank a working page.
 */
export function useShellSubscriptionStatus() {
    return useQuery(SHELL_READS["billing.subscriptionStatus"]());
}

/** The organizations this account belongs to, for the switcher. Suspends inside the sidebar's boundary. */
export function useShellOrganizations() {
    return useSuspenseQuery(SHELL_READS["organization.mine"]());
}

/**
 * Warms the switcher from the app-shell loader, so it does not start when the sidebar mounts
 * mid-page. A later `useSuspenseQuery` observer joins this promise rather than opening a second fetch.
 */
export function prefetchShellOrganizations(queryClient: QueryClient): void {
    void queryClient.prefetchQuery(SHELL_READS["organization.mine"]());
}

/**
 * The active organization's server-computed flags (`isDemo`, `canReturnToAccount`). Read by the demo
 * banner; the loader has already resolved it, so this is a cache read on every normal navigation.
 */
export function useShellActiveOrg() {
    return useQuery(SHELL_READS["auth.activeOrg"]());
}

/**
 * The "fix it" backlog, read inside the suite-health dialog. Suspends within the dialog body's own
 * boundary, so a slow read blanks that panel rather than the dialog.
 */
export function useShellSuiteHealthFixPlan() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(SHELL_READS["applications.suiteHealthFixPlan"](currentApp.id));
}

// --- Mutations ---
//
// Re-exported rather than registered: a mutation fires from a click, so it never shares a render tick
// with a page's queries and there is nothing to route it out of. They live here so the rule the
// boundary test enforces stays total - the shell takes ALL of its server state from this module, with
// no per-hook judgement about which imports are allowed.

export { useDeleteApplication } from "./applications.queries";
export { useCreateCheckoutSession } from "./billing.queries";
export { useSwitchOrganization } from "./organization.queries";
