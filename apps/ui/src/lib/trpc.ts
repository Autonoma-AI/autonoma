import type { AppRouter } from "@autonoma/api/router";
import { isPreviewHostname } from "@autonoma/types";
import * as Sentry from "@sentry/react";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { env } from "env";
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

const linkOptions = {
    url: isPreviewEnvironment ? `${env.VITE_API_URL}/v1/trpc` : "/v1/trpc",
    transformer: superjson,
    ...(isPreviewEnvironment && {
        fetch: (url: RequestInfo | URL, options?: RequestInit) => fetch(url, { ...options, credentials: "include" }),
    }),
} as const;

export const trpcClient = createTRPCClient<AppRouter>({
    links: [
        splitLink({
            condition: (op) => op.input instanceof FormData,
            true: httpLink(linkOptions),
            false: httpBatchLink(linkOptions),
        }),
    ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });

export type TRPCOptionsProxy = typeof trpc;
