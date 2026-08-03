import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { RouterOutputs } from "lib/trpc";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

type PreviewState = RouterOutputs["previewAccess"]["status"]["state"];

/** Runtime power/health of a preview, straight from the cluster (asleep | waking | healthy | error | unknown). */
export type PreviewLivenessState = RouterOutputs["previewAccess"]["livenessForApplication"][string];

/**
 * How often list views re-poll preview liveness. Slower than the waiting page's
 * wake poll (this is a passive "is it up" glance, and the server already caches a
 * whole-fleet snapshot for a few seconds), and - unlike the waiting page - this
 * read NEVER wakes a preview, so polling it behind a list is free of side effects.
 */
const LIVENESS_POLL_MS = 8_000;

/**
 * How often the waiting page re-checks a cold preview. Each poll sends a real
 * request to the environment, which is what keeps the wake progressing; measured
 * wakes are ~50s at p50, so this is frequent enough to feel responsive without
 * hammering a starting pod.
 */
const POLL_MS = 3_000;

/**
 * The only states that change on their own, so the only ones worth polling. Framed
 * as the active set rather than its complement on purpose: a state not listed here
 * stops the poll, so a future state added to the union defaults to "settled, stop"
 * - a page that stops with stale data, never one that polls a dead preview forever.
 * Typed against the union so a renamed state is a compile error here.
 */
const ACTIVE_STATES: ReadonlySet<PreviewState> = new Set<PreviewState>(["waking", "deploying"]);

function isActivePreviewState(state: PreviewState): boolean {
    return ACTIVE_STATES.has(state);
}

/**
 * Liveness of a single preview, for the waiting page.
 *
 * Polling this WAKES the environment - correct here, because the visitor is trying
 * to open it, and the request itself is what starts the wake. Never call this to
 * render a list: one page load would wake every preview on it.
 */
export function usePreviewStatus(url: string) {
    return useSuspenseQuery({
        ...trpc.previewAccess.status.queryOptions({ url }),
        refetchInterval: (query) => {
            const state = query.state.data?.state;
            // No data yet is "keep checking"; a known non-active state is terminal.
            return state == null || isActivePreviewState(state) ? POLL_MS : false;
        },
        // A cold start outlasts the tab losing focus - someone opens the preview,
        // switches away while it warms, and comes back. Without this the poll
        // pauses and they return to a page still claiming it is starting.
        refetchIntervalInBackground: true,
    });
}

/**
 * Runtime liveness for every preview the CURRENT APPLICATION has, keyed by URL, for LIST views. A pure read that
 * NEVER wakes a preview, so it is safe to poll behind a list.
 *
 * The caller names the application, not the URLs. Sending one URL per row back to the server that produced them
 * was ~10-15KB of query string at a few hundred rows, which the edge rejects with 414 - taking down every other
 * procedure sharing the tRPC batch with it.
 */
export function useApplicationPreviewLiveness() {
    const currentApp = useCurrentApplication();
    return useQuery({
        ...trpc.previewAccess.livenessForApplication.queryOptions({ applicationId: currentApp.id }),
        refetchInterval: LIVENESS_POLL_MS,
    });
}

/**
 * The single liveness state for one preview from a liveness map: every URL of a
 * preview resolves to the same namespace state, so take the first that is known.
 * "unknown" when none resolve (feature off, or not our preview).
 */
export function pickPreviewLiveness(
    map: Record<string, PreviewLivenessState> | undefined,
    urls: Array<string | undefined>,
): PreviewLivenessState {
    if (map == null) return "unknown";
    for (const url of urls) {
        if (url == null) continue;
        const state = map[url];
        if (state != null && state !== "unknown") return state;
    }
    return "unknown";
}

/**
 * The same map for every preview in the fleet, across organizations - the admin previewkit view, which has no
 * single application to key on. Internal-only, like the environments list it sits beside.
 */
export function useFleetPreviewLiveness() {
    return useQuery({
        ...trpc.previewAccess.livenessForFleet.queryOptions(),
        refetchInterval: LIVENESS_POLL_MS,
    });
}
