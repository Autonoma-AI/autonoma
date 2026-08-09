import { type QueryClient, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { clearLastAppId } from "../../routes/_blacklight/_app-shell/-last-app";
import { ensureAPIQueryData } from "./api-queries";

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

/**
 * Which of the caller's organizations can open an application slug. Used by the cross-organization
 * deep link rescue; `enabled` is false until we actually need it (the app was not found).
 */
export function useAppSlugOwners(appSlug: string, enabled: boolean) {
    return useQuery({ ...trpc.organization.appSlugOwners.queryOptions({ appSlug }), enabled });
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

interface SwitchOrganizationOptions {
    /**
     * Where to land after switching. Defaults to the app hub, and the default is the important part:
     * almost every page that can switch lives at `/app/<slug>/...`, and that slug belongs to the
     * organization being left. Staying on the URL leaves the previous organization's application on
     * screen with nothing to make it re-resolve - a refresh then lands on a slug the new organization
     * does not have. The hub deep-links into an application from the *active* organization's list, so
     * it is the one destination that is always correct.
     */
    redirectTo?: string;
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
export function useSwitchOrganization({ redirectTo }: SwitchOrganizationOptions = {}) {
    const navigate = useNavigate();

    return useAPIMutation(
        trpc.organization.setActive.mutationOptions({
            onSuccess: async () => {
                // The remembered application belongs to the organization being left.
                clearLastAppId();

                // A full document load, and the alternative is worse than it looks.
                //
                // Invalidating the router instead re-runs the loaders of the route still on screen -
                // `/app/<slug>/...`, whose slug the new organization does not have. That renders
                // `AppNotFound`, and for an admin that component looks the slug up across orgs and
                // *switches back* into whichever one owns it (see `-app-not-found.tsx`), so the switch
                // silently undoes itself. Simply navigating is not enough either: `_app-shell` stays
                // matched, so `context.applications` keeps the previous organization's list and the hub
                // deep-links straight back into it.
                //
                // Reloading discards every cache in one step - session, organization list,
                // applications, router context - which is what the same situation already does after
                // an admin cross-org switch.
                await navigate({ href: redirectTo ?? "/", reloadDocument: true, replace: true });
            },
        }),
    );
}

export function useRenameOrganization() {
    const queryClient = useQueryClient();
    const router = useRouter();

    return useAPIMutation({
        ...trpc.organization.rename.mutationOptions({
            // `onSuccess`, not `onSettled`: React Query awaits this before the caller's own
            // `onSuccess`, which is what lets the naming screen navigate straight afterwards and
            // still find a settled cache.
            onSuccess: async () => {
                invalidateOrganization(queryClient);

                // Two things here are load-bearing, and getting either wrong sends the naming screen
                // into a redirect loop back to itself.
                //
                // `refetchType: "all"` because nothing on that screen *observes* `activeOrg` - it
                // reads the name from its loader - and the default ("active") marks the query stale
                // without refetching it. The app-shell guard then reads `needsNaming: true` from
                // cache and bounces straight back here.
                //
                // Awaited for the same reason: that guard calls `ensureQueryData`, which returns
                // whatever is cached at that moment and does not wait for a fetch in flight.
                await queryClient.invalidateQueries({
                    queryKey: trpc.auth.activeOrg.queryKey(),
                    refetchType: "all",
                });

                // The name also appears in the sidebar and the app-shell route context, so the
                // router has to re-resolve, not just the organization lists.
                await router.invalidate();
            },
        }),
        successToast: { title: "Organization renamed" },
    });
}

export function useLeaveOrganization() {
    const navigate = useNavigate();

    return useAPIMutation({
        ...trpc.organization.leave.mutationOptions({
            onSuccess: async () => {
                // Leaving moves the session to a remaining membership server-side, which leaves the
                // URL naming an application the new organization does not have - the same trap a
                // switch falls into, so the same full reload.
                clearLastAppId();
                await navigate({ href: "/", reloadDocument: true, replace: true });
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
