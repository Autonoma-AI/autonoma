import type { AppRouter } from "@autonoma/api/router";
import { isPreviewHostname, POSTHOG_SESSION_HEADER } from "@autonoma/types";
import * as Sentry from "@sentry/react";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { env } from "env";
import { demoModalStore } from "lib/demo-modal-store";
import { isDemoReadOnlyError } from "lib/demo-read-only-error";
import posthog from "posthog-js";
import superjson from "superjson";

export type RouterOutputs = inferRouterOutputs<AppRouter>;

function getEventPath(key: unknown): string | undefined {
    if (!Array.isArray(key)) return undefined;
    const first: unknown = key[0];
    if (!Array.isArray(first)) return undefined;
    return first.join(".");
}

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // 30 s stale time prevents loaders from re-blocking on cache hits
            // and eliminates the "blank screen flash" during navigation
            staleTime: 30_000,
        },
    },
    mutationCache: new MutationCache({
        onMutate: (variables, mutation) => {
            const event = getEventPath(mutation.options.mutationKey);
            if (event != null) {
                posthog.capture(`${event}.started`, variables as Record<string, unknown>);
                // TODO: replace with logger.info when frontend logger is available
                Sentry.addBreadcrumb({ category: "mutation", message: event, level: "info" });
            }
        },
        onSuccess: (data, variables, _context, mutation) => {
            const event = getEventPath(mutation.options.mutationKey);
            if (event != null) {
                posthog.capture(event, { ...(variables as Record<string, unknown>), data });
            }
        },
        onError: (error, variables, _context, mutation) => {
            // A write blocked by the read-only demo org is an expected UX gate, not a
            // failure: pop the "sign up to continue" modal (globally, so no per-control
            // guards) and skip the Sentry/error-toast path a real error would take.
            if (isDemoReadOnlyError(error)) {
                demoModalStore.open();
                return;
            }
            // TODO: replace with logger.error when frontend logger is available
            Sentry.captureException(error);
            const event = getEventPath(mutation.options.mutationKey);
            if (event != null) {
                posthog.capture(`${event}.error`, variables as Record<string, unknown>);
            }
        },
    }),
    queryCache: new QueryCache({
        onError: (error, query) => {
            Sentry.captureException(error);
            const event = getEventPath(query.queryKey);
            if (event != null) {
                posthog.capture(`${event}.error`);
            }
        },
    }),
});

const isPreviewEnvironment = isPreviewHostname(window.location.hostname, env.VITE_INTERNAL_DOMAIN);

/**
 * Sends the browser's PostHog session id so events the API captures while
 * serving the request resolve to this session's recording - the difference
 * between knowing an onboarding step failed and being able to watch someone hit
 * it. Mirrors what the CLI already does with its run id.
 *
 * `get_session_id()` answers `""` before `posthog.init` (dev, or no key), so the
 * header is simply omitted there rather than sent empty.
 */
function analyticsHeaders(): Record<string, string> {
    const sessionId = posthog.get_session_id();
    return sessionId !== "" ? { [POSTHOG_SESSION_HEADER]: sessionId } : {};
}

const linkOptions = {
    url: isPreviewEnvironment ? `${env.VITE_API_URL}/v1/trpc` : "/v1/trpc",
    transformer: superjson,
    headers: analyticsHeaders,
    ...(isPreviewEnvironment && {
        fetch: (url: RequestInfo | URL, options?: RequestInit) => fetch(url, { ...options, credentials: "include" }),
    }),
} as const;

/** Operation-context key that routes a query around `httpBatchLink`. Read by the `splitLink` below. */
const SKIP_BATCH = "skipBatch";

/**
 * Query options that keep a query out of the shared HTTP batch. A batch resolves only when its SLOWEST member
 * does, so anything that renders outside the page it happens to share a tick with paints at that page's speed:
 * the sidebar's suite-health meter is a ~50ms query, and batched behind a 300-pull-request `branches.list` it
 * sits on a skeleton for seconds. Pass as the second argument to `queryOptions`.
 */
export const UNBATCHED = { trpc: { context: { [SKIP_BATCH]: true } } };

/**
 * Split a batch rather than let its URL grow unbounded. A batched query is a GET with every member's input in the
 * query string, and our edge answers 414 past ~8-12KB of it - which fails the WHOLE batch, including procedures
 * whose own input was two fields. Individual procedures should not be shipping large inputs in the first place
 * (key them by an id and resolve server-side), but this keeps one that does from taking its neighbours with it.
 */
const MAX_BATCH_URL_LENGTH = 8_000;

export const trpcClient = createTRPCClient<AppRouter>({
    links: [
        splitLink({
            condition: (op) => op.input instanceof FormData || op.context[SKIP_BATCH] === true,
            true: httpLink(linkOptions),
            false: httpBatchLink({ ...linkOptions, maxURLLength: MAX_BATCH_URL_LENGTH }),
        }),
    ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });

export type TRPCOptionsProxy = typeof trpc;
