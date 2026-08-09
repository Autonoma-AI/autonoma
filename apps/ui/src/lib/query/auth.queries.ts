import type { QueryClient } from "@tanstack/react-query";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { authClient } from "lib/auth";
import { trpc } from "lib/trpc";
import { ensureAPIQueryData } from "./api-queries";

// --- Session ---

export function sessionQueryOptions() {
    return queryOptions({
        queryKey: ["auth", "session"],
        queryFn: async () => {
            const result = await authClient.getSession();
            return result.data;
        },
    });
}

export function useSession() {
    return useQuery(sessionQueryOptions());
}

export function ensureSessionData(queryClient: QueryClient) {
    return queryClient.ensureQueryData(sessionQueryOptions());
}

// --- Organizations ---

export function organizationsQueryOptions() {
    return queryOptions({
        queryKey: ["auth", "organizations"],
        queryFn: async () => {
            const result = await authClient.organization.list();
            if (result.error != null) throw new Error(result.error.message ?? "Failed to fetch organizations");
            return result.data;
        },
    });
}

export function useOrganizations() {
    return useQuery(organizationsQueryOptions());
}

export function ensureOrganizationsData(queryClient: QueryClient) {
    return queryClient.ensureQueryData(organizationsQueryOptions());
}

// --- Org Status ---

export function ensureOrgStatusData(queryClient: QueryClient) {
    return ensureAPIQueryData(queryClient, trpc.auth.orgStatus.queryOptions());
}

// --- Active Org ---

// Carries the server-computed flags that drive org-shaped UI: `isDemo` for the read-only demo UX,
// `needsNaming` for an organization still carrying the name it was auto-given.
export function activeOrgQueryOptions() {
    return trpc.auth.activeOrg.queryOptions();
}

export function useActiveOrg() {
    return useQuery(activeOrgQueryOptions());
}

// --- Social sign-in providers ---

// Which providers this environment has credentials for. Prefetched by the login
// route so the buttons render in one pass, with no flash of a provider we then
// withdraw.
export function ensureSocialProvidersData(queryClient: QueryClient) {
    return ensureAPIQueryData(queryClient, trpc.auth.socialProviders.queryOptions());
}

export function useSocialProviders() {
    return useSuspenseQuery(trpc.auth.socialProviders.queryOptions());
}
