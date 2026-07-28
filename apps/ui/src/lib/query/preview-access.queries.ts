import { useSuspenseQuery } from "@tanstack/react-query";
import type { RouterOutputs } from "lib/trpc";
import { trpc } from "lib/trpc";

type PreviewState = RouterOutputs["previewAccess"]["status"]["state"];

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
