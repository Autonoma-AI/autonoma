import { z } from "zod";

/**
 * The invitation lifecycle, matching the values better-auth's organization plugin already
 * writes into `invitation.status` - the column is a bare String, so this enum is the only
 * thing keeping both writers on the same vocabulary.
 *
 * `expired` is deliberately absent: expiry is `expiresAt` vs. now, never a stored status,
 * so a row can't drift into disagreeing with its own timestamp. The read models below
 * derive it instead.
 */
export const InvitationStatusSchema = z.enum(["pending", "accepted", "rejected", "canceled"]);
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

export const InviteMemberInputSchema = z.object({
    email: z.email("Enter a valid email address").trim().toLowerCase(),
});
export type InviteMemberInput = z.infer<typeof InviteMemberInputSchema>;

export const RevokeInvitationInputSchema = z.object({
    invitationId: z.string().min(1),
});
export type RevokeInvitationInput = z.infer<typeof RevokeInvitationInputSchema>;

export const RemoveMemberInputSchema = z.object({
    userId: z.string().min(1),
});
export type RemoveMemberInput = z.infer<typeof RemoveMemberInputSchema>;

export const InvitationIdInputSchema = z.object({
    invitationId: z.string().min(1),
});
export type InvitationIdInput = z.infer<typeof InvitationIdInputSchema>;

export const SetActiveOrganizationInputSchema = z.object({
    organizationId: z.string().min(1),
});
export type SetActiveOrganizationInput = z.infer<typeof SetActiveOrganizationInputSchema>;

export const RenameOrganizationInputSchema = z.object({
    organizationId: z.string().min(1),
    name: z.string().trim().min(1, "Enter a name").max(100, "Keep it under 100 characters"),
});
export type RenameOrganizationInput = z.infer<typeof RenameOrganizationInputSchema>;

export const LeaveOrganizationInputSchema = z.object({
    organizationId: z.string().min(1),
});
export type LeaveOrganizationInput = z.infer<typeof LeaveOrganizationInputSchema>;

/**
 * How an invitation looks to the person opening its link. `outcome` is what the page
 * branches on, so every terminal state is named rather than inferred from a mix of
 * status, timestamp and email comparison at the call site.
 *
 * - `joinable` - pending, unexpired, and the signed-in user's email matches.
 * - `wrong-account` - valid, but signed in as somebody else. `invitedEmail` says who to be.
 * - `already-member` - the user is already in this org; nothing to do.
 * - `expired` / `revoked` / `accepted` / `declined` - dead ends, distinguished so the copy can be.
 */
export const InvitationOutcomeSchema = z.enum([
    "joinable",
    "wrong-account",
    "already-member",
    "expired",
    "revoked",
    "accepted",
    "declined",
]);
export type InvitationOutcome = z.infer<typeof InvitationOutcomeSchema>;

export const InvitationPreviewSchema = z.object({
    invitationId: z.string(),
    organizationName: z.string(),
    inviterName: z.string(),
    invitedEmail: z.string(),
    outcome: InvitationOutcomeSchema,
});
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;

/**
 * One organization the signed-in user belongs to. Drives both the account's organization
 * list and the post-login picker, so it carries what someone needs to tell two of their own
 * organizations apart - not just the name.
 */
export const MyOrganizationSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** Which one the current session is acting as. Session-scoped: switching does not persist. */
    isActive: z.boolean(),
    memberCount: z.number().int().positive(),
    applicationCount: z.number().int().nonnegative(),
    joinedAt: z.date(),
    /**
     * Why leaving is refused, if it is. `last-organization` - it is their only one, and an
     * account with no organization cannot reach anything. `last-member` - nobody would be
     * left who could reach the organization's applications.
     */
    leaveBlockedReason: z.enum(["last-organization", "last-member"]).optional(),
});
export type MyOrganization = z.infer<typeof MyOrganizationSchema>;

export const OrganizationMemberSchema = z.object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().optional(),
    role: z.string(),
    joinedAt: z.date(),
    /** True for the member making the request - the row that can't be removed. */
    isSelf: z.boolean(),
});
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const PendingInvitationSchema = z.object({
    id: z.string(),
    email: z.string(),
    inviterName: z.string(),
    expiresAt: z.date(),
    /** Where to send the invitee if the email never arrives and someone wants to paste the link. */
    acceptUrl: z.string(),
});
export type PendingInvitation = z.infer<typeof PendingInvitationSchema>;
