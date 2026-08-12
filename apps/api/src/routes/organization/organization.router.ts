import {
    AppSlugOwnersInputSchema,
    InvitationIdInputSchema,
    InviteMemberInputSchema,
    LeaveOrganizationInputSchema,
    RemoveMemberInputSchema,
    RenameOrganizationInputSchema,
    RevokeInvitationInputSchema,
    SetActiveOrganizationInputSchema,
} from "@autonoma/types";
import { protectedProcedure, router, writeProcedure } from "../../trpc";

export const organizationRouter = router({
    /**
     * Every organization the account belongs to, for the account's organization list and the
     * post-login picker. Not scoped to the active org - it is the one read that deliberately spans
     * all of them.
     */
    mine: protectedProcedure.query(({ ctx: { services, user, session } }) =>
        services.organization.myOrganizations(user, session.activeOrganizationId ?? undefined),
    ),

    /**
     * Switches which organization this session acts as, and remembers it for the next one. Replaces
     * better-auth's `organization/set-active`, which cannot persist the choice.
     */
    setActive: writeProcedure
        .input(SetActiveOrganizationInputSchema)
        .mutation(({ ctx: { services, user, session }, input }) =>
            services.organization.setActive(input.organizationId, user, session.token),
        ),

    rename: writeProcedure
        .input(RenameOrganizationInputSchema)
        .mutation(({ ctx: { services, user }, input }) =>
            services.organization.rename(input.organizationId, user, input.name),
        ),

    /**
     * Where the caller can open an application slug. Drives the cross-organization deep link rescue,
     * which is why it is a plain `protectedProcedure` and not admin-gated: anyone in more than one
     * organization can receive a link to an app in the other one.
     */
    appSlugOwners: protectedProcedure
        .input(AppSlugOwnersInputSchema)
        .query(({ ctx: { services, user }, input }) => services.organization.appSlugOwners(input.appSlug, user)),

    leave: writeProcedure
        .input(LeaveOrganizationInputSchema)
        .mutation(({ ctx: { services, user, session }, input }) =>
            services.organization.leave(input.organizationId, user, session.token),
        ),

    members: protectedProcedure.query(({ ctx: { services, organizationId, user } }) =>
        services.organization.listMembers(organizationId, user.id),
    ),

    invitations: protectedProcedure.query(({ ctx: { services, organizationId } }) =>
        services.organization.listInvitations(organizationId),
    ),

    invite: writeProcedure
        .input(InviteMemberInputSchema)
        .mutation(({ ctx: { services, organizationId, user }, input }) =>
            services.organization.invite(organizationId, user, input.email),
        ),

    revokeInvitation: writeProcedure
        .input(RevokeInvitationInputSchema)
        .mutation(({ ctx: { services, organizationId, user }, input }) =>
            services.organization.revokeInvitation(organizationId, user, input.invitationId),
        ),

    removeMember: writeProcedure
        .input(RemoveMemberInputSchema)
        .mutation(({ ctx: { services, organizationId, user }, input }) =>
            services.organization.removeMember(organizationId, user, input.userId, input.apiKeyIds),
        ),

    // The three invitee-facing procedures below are keyed by the invitation, not by the
    // caller's active organization - the whole point is that the caller is not in the target
    // org yet. They still require a session: the invitation is only ever matched against the
    // signed-in user's own email address.
    invitation: protectedProcedure
        .input(InvitationIdInputSchema)
        .query(({ ctx: { services, user }, input }) => services.organization.preview(input.invitationId, user)),

    acceptInvitation: writeProcedure
        .input(InvitationIdInputSchema)
        .mutation(({ ctx: { services, user, session }, input }) =>
            services.organization.accept(input.invitationId, user, session.token),
        ),

    declineInvitation: writeProcedure
        .input(InvitationIdInputSchema)
        .mutation(({ ctx: { services, user }, input }) => services.organization.decline(input.invitationId, user)),
});
