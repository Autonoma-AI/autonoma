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
import posthog from "lib/posthog";
import { shouldSkipBatch } from "lib/trpc-batching";
import superjson from "superjson";

export type RouterOutputs = inferRouterOutputs<AppRouter>;

function getEventPath(key: unknown): string | undefined {
    if (!Array.isArray(key)) return undefined;
    const first: unknown = key[0];
    if (!Array.isArray(first)) return undefined;
    return first.join(".");
}

/**
 * The query behaviour the app runs with, exported so Storybook's QueryClient can layer its own
 * options over it rather than replace it. `lib/storybook/page-story.tsx` set only `retry: false`,
 * which left `staleTime` at react-query's default of 0 - so every observer mount refetched and the
 * stories issued requests no real screen issues. The instrument used to measure request behaviour
 * has to agree with the app about it.
 */
export const DEFAULT_QUERY_OPTIONS = {
    // 30 s stale time prevents loaders from re-blocking on cache hits
    // and eliminates the "blank screen flash" during navigation
    staleTime: 30_000,
} as const;

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: DEFAULT_QUERY_OPTIONS,
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

// `typeof window` guarded because this runs at module scope: an unguarded read makes this module,
// and everything downstream of it, impossible to import outside a browser - which is why the query
// layer had no tests. Always true in the app itself; false only under a test runner.
const isPreviewEnvironment =
    typeof window !== "undefined" && isPreviewHostname(window.location.hostname, env.VITE_INTERNAL_DOMAIN);

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
            condition: shouldSkipBatch,
            true: httpLink(linkOptions),
            false: httpBatchLink({ ...linkOptions, maxURLLength: MAX_BATCH_URL_LENGTH }),
        }),
    ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });

export type TRPCOptionsProxy = typeof trpc;
