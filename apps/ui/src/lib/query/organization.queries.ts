import { type QueryClient, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { ensureAPIQueryData } from "./api-queries";
import { organizationsQueryOptions, sessionQueryOptions } from "./auth.queries";

export function useOrganizationMembers() {
    return useSuspenseQuery(trpc.organization.members.queryOptions());
}

// --- The organizations this account belongs to ---

export function myOrganizationsQueryOptions() {
    return trpc.organization.mine.queryOptions();
}

export function ensureMyOrganizationsData(queryClient: QueryClient) {
    return ensureAPIQueryData(queryClient, myOrganizationsQueryOptions());
}

export function useMyOrganizations() {
    return useSuspenseQuery(myOrganizationsQueryOptions());
}

export function useOrganizationInvitations() {
    return useSuspenseQuery(trpc.organization.invitations.queryOptions());
}

/** These change together on every membership write, so they invalidate together. */
function invalidateOrganization(queryClient: QueryClient) {
    void queryClient.invalidateQueries({ queryKey: trpc.organization.members.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.organization.invitations.queryKey() });
    void queryClient.invalidateQueries({ queryKey: myOrganizationsQueryOptions().queryKey });
}

/**
 * Switches which organization this session acts as, then rebuilds everything downstream of it.
 *
 * Goes through `organization.setActive` rather than better-auth's own `setActive` (which the API
 * refuses) because only ours persists the choice to `user.lastOrganizationId` - otherwise the next
 * sign-in would land back in the oldest membership.
 *
 * Every app-scoped query in the cache was answered for the previous organization, so the router is
 * invalidated too: route loaders hold the application list the sidebar and app selector read from,
 * and nothing observes that query directly.
 */
export function useSwitchOrganization() {
    const queryClient = useQueryClient();
    const router = useRouter();

    return useAPIMutation(
        trpc.organization.setActive.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries();
                void queryClient.invalidateQueries({ queryKey: sessionQueryOptions().queryKey });
                void queryClient.invalidateQueries({ queryKey: organizationsQueryOptions().queryKey });
                await router.invalidate();
            },
        }),
    );
}

export function useRenameOrganization() {
    const queryClient = useQueryClient();
    const router = useRouter();

    return useAPIMutation({
        ...trpc.organization.rename.mutationOptions({
            onSettled: async () => {
                // The organization name appears in the sidebar and the app-shell route context, so
                // the router has to re-resolve, not just the organization lists.
                invalidateOrganization(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.auth.activeOrg.queryKey() });
                await router.invalidate();
            },
        }),
        successToast: { title: "Organization renamed" },
    });
}

export function useLeaveOrganization() {
    const queryClient = useQueryClient();
    const router = useRouter();

    return useAPIMutation({
        ...trpc.organization.leave.mutationOptions({
            onSettled: async () => {
                // Leaving can move the session to a different organization server-side, so the whole
                // cache and every route loader are stale, not just the organization lists.
                await queryClient.invalidateQueries();
                void queryClient.invalidateQueries({ queryKey: sessionQueryOptions().queryKey });
                await router.invalidate();
            },
        }),
        successToast: { title: "You left the organization" },
    });
}

export function useInviteMember() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.organization.invite.mutationOptions({
            onSettled: () => invalidateOrganization(queryClient),
        }),
        successToast: (_data, variables) => ({
            title: "Invitation sent",
            description: `${variables.email} can now join this organization.`,
        }),
    });
}

export function useRevokeInvitation() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.organization.revokeInvitation.mutationOptions({
            onSettled: () => invalidateOrganization(queryClient),
        }),
        successToast: { title: "Invitation revoked" },
    });
}

export function useRemoveMember() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.organization.removeMember.mutationOptions({
            onSettled: () => invalidateOrganization(queryClient),
        }),
        successToast: { title: "Member removed" },
    });
}

// --- Invitation acceptance (the invitee's side) ---

export function invitationQueryOptions(invitationId: string) {
    return trpc.organization.invitation.queryOptions({ invitationId });
}

export function ensureInvitationData(queryClient: QueryClient, invitationId: string) {
    return ensureAPIQueryData(queryClient, invitationQueryOptions(invitationId));
}

export function useInvitation(invitationId: string) {
    return useSuspenseQuery(invitationQueryOptions(invitationId));
}

/**
 * Accepting moves the user between organizations, so the whole cache is stale afterwards -
 * every query in the app was answered for the org they just left. The caller navigates on
 * success; clearing wholesale is cheaper to reason about than enumerating what survived.
 */
export function useAcceptInvitation() {
    const queryClient = useQueryClient();
    return useAPIMutation(
        trpc.organization.acceptInvitation.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries();
            },
        }),
    );
}

export function useDeclineInvitation() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.organization.declineInvitation.mutationOptions({
            onSettled: () => invalidateOrganization(queryClient),
        }),
        successToast: { title: "Invitation declined" },
    });
}
