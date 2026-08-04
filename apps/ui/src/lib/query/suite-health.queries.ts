import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { UNBATCHED, trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

/**
 * Suite health only moves when an analysis run finishes, which is minutes apart at best - so this refetches on a
 * slow interval rather than a live one, and only while the tab is focused.
 */
const REFETCH_INTERVAL_MS = 60_000;

/**
 * Unbatched: the meter lives in the sidebar, so it fires on every page and would otherwise ride in whatever batch
 * that page's own queries form. The query costs ~50ms; the pull-request list it sits beside costs seconds.
 */
export function useSuiteHealth() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery({
        ...trpc.applications.suiteHealth.queryOptions({ applicationId: currentApp.id }, UNBATCHED),
        refetchInterval: REFETCH_INTERVAL_MS,
    });
}

/**
 * Warms the meter from an app route loader. Fire-and-forget rather than an `ensure*`: the meter is
 * sidebar furniture and must never hold up the page, and {@link useSuiteHealth} resolves from the
 * fetch this starts. Keeps `UNBATCHED` so it does not join the loader's batch - see {@link UNBATCHED}.
 */
export function prefetchSuiteHealth(queryClient: QueryClient, applicationId: string): void {
    void queryClient.prefetchQuery(trpc.applications.suiteHealth.queryOptions({ applicationId }, UNBATCHED));
}

/**
 * The "fix it" backlog. Not polled: it is only ever read inside an open dialog, and it is a heavier query than the
 * meter - for an app whose runs never reach the Reporter it falls back to scanning findings.
 */
export function useSuiteHealthFixPlan() {
    const currentApp = useCurrentApplication();
    return useSuspenseQuery(
        trpc.applications.suiteHealthFixPlan.queryOptions({ applicationId: currentApp.id }, UNBATCHED),
    );
}
