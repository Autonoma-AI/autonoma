import type { PostHogAnalytics } from "@autonoma/analytics";
import { ensureBillingProvisioning } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import {
    type AppSlugOwner,
    type InvitationOutcome,
    type InvitationPreview,
    type MyOrganization,
    type OrganizationMember,
    type PendingInvitation,
    emailAutoJoinsOrg,
} from "@autonoma/types";
import type { Auth } from "../../auth";
import type { EmailSender } from "../../email/email-sender";
import { setSessionActiveOrg } from "../auth/set-session-active-org";
import { Service } from "../service";
import { buildInvitationEmail } from "./invitation-email";
import { preferCustomerOrgs } from "./prefer-customer-orgs";

const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * The role every invited member gets. Nothing in the product reads `member.role` yet - the
 * org bootstrapper is `owner` and everyone auto-joined by domain is too - so this is a
 * placeholder for a permission model rather than a permission itself. Invited members are
 * marked `member` so that when roles do start mattering, the distinction is already recorded
 * instead of having to be reconstructed from `createdAt`.
 */
const INVITED_ROLE = "member";

/** better-auth's organization plugin writes these same strings into `invitation.status`. */
const STATUS = {
    pending: "pending",
    accepted: "accepted",
    rejected: "rejected",
    canceled: "canceled",
} as const;

interface ActorUser {
    id: string;
    name: string;
    email: string;
    role: string;
}

interface LeaveEligibility {
    /** How many organizations the user belongs to in total. */
    organizationCount: number;
    /** How many members the organization they want to leave has. */
    memberCount: number;
}

/**
 * Why leaving would be refused, or undefined when it is allowed. Shared by the read that renders
 * the list and the write that performs the leave, so the button's disabled state and the server's
 * answer cannot disagree.
 */
function resolveLeaveBlockedReason({
    organizationCount,
    memberCount,
}: LeaveEligibility): MyOrganization["leaveBlockedReason"] {
    // An account with zero memberships can reach nothing, and `ensureOrgMembership` would mint a
    // fresh empty organization on their next sign-in rather than returning them here.
    if (organizationCount <= 1) return "last-organization";
    // Nothing could ever grant access to an organization with no members again.
    if (memberCount <= 1) return "last-member";
    return undefined;
}

export class OrganizationService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly auth: Auth,
        private readonly emailSender: EmailSender,
        private readonly analytics: PostHogAnalytics,
        private readonly appUrl: string,
        /** Bare domain of the internal org, so slug lookups can prefer a customer's copy. */
        private readonly internalDomain: string,
        /** Sender for invitation emails - the product, not the environment's default person. */
        private readonly invitesFromEmail: string,
    ) {
        super();
    }

    async listMembers(organizationId: string, requesterId: string): Promise<OrganizationMember[]> {
        this.logger.info("Listing organization members", { organizationId });

        const members = await this.db.member.findMany({
            where: { organizationId },
            select: {
                userId: true,
                role: true,
                createdAt: true,
                user: { select: { name: true, email: true, image: true } },
            },
            orderBy: { createdAt: "asc" },
        });

        this.logger.info("Listed organization members", { organizationId, extra: { count: members.length } });

        return members.map((member) => ({
            userId: member.userId,
            name: member.user.name,
            email: member.user.email,
            image: member.user.image ?? undefined,
            role: member.role,
            joinedAt: member.createdAt,
            isSelf: member.userId === requesterId,
        }));
    }

    async listInvitations(organizationId: string): Promise<PendingInvitation[]> {
        this.logger.info("Listing pending invitations", { organizationId });

        const invitations = await this.db.invitation.findMany({
            where: { organizationId, status: STATUS.pending, expiresAt: { gt: new Date() } },
            select: {
                id: true,
                email: true,
                expiresAt: true,
                inviter: { select: { name: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Listed pending invitations", { organizationId, extra: { count: invitations.length } });

        return invitations.map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            inviterName: invitation.inviter.name.length > 0 ? invitation.inviter.name : invitation.inviter.email,
            expiresAt: invitation.expiresAt,
            acceptUrl: this.acceptUrl(invitation.id),
        }));
    }

    async invite(organizationId: string, inviter: ActorUser, email: string): Promise<PendingInvitation> {
        this.logger.info("Inviting member", { organizationId, extra: { email } });

        // Three independent reads: the org being invited to, whether this address is already in it,
        // and whether it already has live invitations. The inviter's display name comes off the
        // authenticated user rather than a fourth query.
        const [organization, existingMember, pendingInvitations] = await Promise.all([
            this.db.organization.findUnique({
                where: { id: organizationId },
                select: { name: true, domain: true },
            }),
            this.db.member.findFirst({
                where: { organizationId, user: { email } },
                select: { userId: true },
            }),
            this.db.invitation.findMany({
                where: { organizationId, email, status: STATUS.pending },
                select: { id: true },
                orderBy: { createdAt: "asc" },
            }),
        ]);

        if (organization == null) throw new NotFoundError("Organization not found");

        // Only pointless when THIS address would be auto-joined anyway. It used to refuse every
        // invitation from a domain-keyed organization, which locked out exactly the people who need
        // an invitation: a contractor on gmail, someone at a partner company, a founder's personal
        // address. None of them will ever be auto-joined, so the invitation is the only way in.
        if (emailAutoJoinsOrg(email, organization.domain ?? undefined)) {
            throw new BadRequestError(
                `${email} joins ${organization.name} automatically with an @${organization.domain} address, so no invitation is needed.`,
            );
        }

        if (existingMember != null) {
            throw new ConflictError(`${email} is already a member of ${organization.name}.`);
        }

        const inviterName = inviter.name.length > 0 ? inviter.name : inviter.email;
        const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

        // Re-inviting the same address refreshes the oldest live invitation rather than adding a
        // second one, so the list can't fill with duplicates and every link already shared for an
        // address stays valid.
        //
        // `invitation` has no unique constraint on (organizationId, email) - it is better-auth's
        // table and a partial unique index is not expressible in the Prisma schema - so two
        // concurrent invites can both find none and both insert. Rather than leave duplicates
        // lying around, cancel any extras here: a race then self-heals on the next invite to that
        // address, and only one link is ever live at a time.
        const [oldestPending, ...duplicates] = pendingInvitations;
        if (duplicates.length > 0) {
            await this.db.invitation.updateMany({
                where: { id: { in: duplicates.map((row) => row.id) } },
                data: { status: STATUS.canceled },
            });
            this.logger.warn("Cancelled duplicate pending invitations", {
                organizationId,
                extra: { email, count: duplicates.length },
            });
        }

        const invitation =
            oldestPending != null
                ? await this.db.invitation.update({
                      where: { id: oldestPending.id },
                      data: { expiresAt, inviterId: inviter.id },
                      select: { id: true, email: true, expiresAt: true },
                  })
                : await this.db.invitation.create({
                      data: {
                          email,
                          organizationId,
                          inviterId: inviter.id,
                          role: INVITED_ROLE,
                          status: STATUS.pending,
                          expiresAt,
                      },
                      select: { id: true, email: true, expiresAt: true },
                  });

        // The invitation is already committed, so a mail failure must not fail the request - the
        // UI exposes the accept link for exactly this case.
        await this.emailSender
            .send(
                buildInvitationEmail({
                    to: invitation.email,
                    from: this.invitesFromEmail,
                    organizationName: organization.name,
                    inviterName,
                    acceptUrl: this.acceptUrl(invitation.id),
                    expiresAt: invitation.expiresAt,
                }),
            )
            .catch((err) => {
                this.logger.error("Failed to send invitation email", {
                    organizationId,
                    extra: { email: invitation.email, invitationId: invitation.id, err },
                });
            });

        this.analytics.capture(
            inviter.id,
            "organization.invite_sent",
            { extra: { invitationId: invitation.id, resent: oldestPending != null } },
            { organization: organizationId },
        );

        this.logger.info("Member invited", {
            organizationId,
            extra: { invitationId: invitation.id, resent: oldestPending != null },
        });

        return {
            id: invitation.id,
            email: invitation.email,
            inviterName,
            expiresAt: invitation.expiresAt,
            acceptUrl: this.acceptUrl(invitation.id),
        };
    }

    async revokeInvitation(organizationId: string, actor: ActorUser, invitationId: string): Promise<void> {
        this.logger.info("Revoking invitation", { organizationId, extra: { invitationId } });

        // Scoped on organizationId as well as id so one org can never cancel another's invitation.
        const result = await this.db.invitation.updateMany({
            where: { id: invitationId, organizationId, status: STATUS.pending },
            data: { status: STATUS.canceled },
        });

        if (result.count === 0) throw new NotFoundError("Invitation not found");

        this.analytics.capture(
            actor.id,
            "organization.invite_revoked",
            { extra: { invitationId } },
            { organization: organizationId },
        );

        this.logger.info("Invitation revoked", { organizationId, extra: { invitationId } });
    }

    async removeMember(organizationId: string, actor: ActorUser, userId: string): Promise<void> {
        this.logger.info("Removing member", { organizationId, extra: { targetUserId: userId } });

        if (userId === actor.id) {
            throw new BadRequestError("You can't remove yourself from the organization.");
        }

        const [member, memberCount] = await Promise.all([
            this.db.member.findUnique({
                where: { userId_organizationId: { userId, organizationId } },
                select: { id: true },
            }),
            this.db.member.count({ where: { organizationId } }),
        ]);

        if (member == null) throw new NotFoundError("Member not found");
        // Unreachable while self-removal is refused, but an org with zero members is
        // unrecoverable - nothing can ever grant access to it again - so it stays guarded.
        if (memberCount <= 1) throw new BadRequestError("An organization must keep at least one member.");

        await this.db.member.delete({ where: { id: member.id } });

        // Deleting the row is not enough to end their access. `protectedProcedure` authorizes on
        // `session.activeOrganizationId` alone and never re-checks membership, so a session already
        // acting as this organization would keep full read/write access to it until it expired -
        // potentially days. Move any such session off, exactly as `leave` does for the user's own.
        await this.evictSessionsFromOrg(userId, organizationId);

        this.analytics.capture(
            actor.id,
            "organization.member_removed",
            { extra: { removedUserId: userId } },
            { organization: organizationId },
        );

        this.logger.info("Member removed", { organizationId, extra: { targetUserId: userId } });
    }

    /**
     * Every organization the user belongs to, for their account's organization list and the
     * post-login picker. `isActive` comes from the session rather than any stored preference:
     * which organization an account is acting as is session state, so two browsers can be in two
     * different organizations at once.
     */
    async myOrganizations(user: ActorUser, activeOrganizationId: string | undefined): Promise<MyOrganization[]> {
        this.logger.info("Listing the user's organizations");

        const memberships = await this.db.member.findMany({
            where: { userId: user.id },
            select: {
                organizationId: true,
                createdAt: true,
                organization: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        _count: { select: { members: true, applications: true } },
                    },
                },
            },
            // Oldest first, matching the order `ensureOrgMembership` resolves a session's default
            // organization in - so the list a user sees is the order the product picks from.
            orderBy: { createdAt: "asc" },
        });

        this.logger.info("Listed the user's organizations", { extra: { count: memberships.length } });

        return memberships.map((membership) => ({
            id: membership.organization.id,
            name: membership.organization.name,
            slug: membership.organization.slug,
            isActive: membership.organizationId === activeOrganizationId,
            memberCount: membership.organization._count.members,
            applicationCount: membership.organization._count.applications,
            joinedAt: membership.createdAt,
            leaveBlockedReason: resolveLeaveBlockedReason({
                organizationCount: memberships.length,
                memberCount: membership.organization._count.members,
            }),
        }));
    }

    /**
     * Which of the user's own organizations own an application with this slug.
     *
     * Application slugs are unique per organization rather than globally, so a link like
     * `/app/checkout` names a different application depending on which organization you are acting
     * as - and lands on "not found" if you happen to be in the wrong one. This is what lets a shared
     * link resolve to the organization that actually has it.
     *
     * Scoped to the caller's memberships on purpose: it answers "where can *I* open this", never
     * "who else has an app by this name", so it leaks nothing about organizations they are not in.
     */
    async appSlugOwners(appSlug: string, user: ActorUser): Promise<AppSlugOwner[]> {
        this.logger.info("Finding the user's organizations that own an app slug", { extra: { appSlug } });

        const memberships = await this.db.member.findMany({
            where: {
                userId: user.id,
                organization: { applications: { some: { slug: appSlug, disabled: false } } },
            },
            select: { organization: { select: { id: true, name: true, slug: true, domain: true } } },
            orderBy: { createdAt: "asc" },
        });

        // The internal org dogfoods customer applications, so it usually owns the same slug. Someone
        // following a shared link wants the customer's copy, not our clone of it.
        const owners = preferCustomerOrgs(memberships, this.internalDomain);

        this.logger.info("Resolved app slug owners", {
            extra: { appSlug, count: owners.length, beforeInternalFilter: memberships.length },
        });

        return owners.map((membership) => ({
            organizationId: membership.organization.id,
            organizationName: membership.organization.name,
            organizationSlug: membership.organization.slug,
        }));
    }

    /**
     * Switches which organization this session acts as, and remembers the choice.
     *
     * Replaces better-auth's own `organization/set-active` (refused in the auth middleware) for two
     * reasons: the plugin cannot persist anything to `user.lastOrganizationId`, so every new session
     * would fall back to the oldest membership and a multi-organization user would be dropped into
     * the wrong organization on each sign-in; and routing it here keeps membership the thing that
     * authorizes the switch.
     */
    async setActive(organizationId: string, user: ActorUser, sessionToken: string | undefined): Promise<void> {
        this.logger.info("Setting active organization", { organizationId });

        const membership = await this.db.member.findUnique({
            where: { userId_organizationId: { userId: user.id, organizationId } },
            select: { id: true },
        });
        if (membership == null) throw new NotFoundError("You are not a member of this organization");

        await this.db.user.update({
            where: { id: user.id },
            data: { lastOrganizationId: organizationId },
        });

        // Only this session. Another browser stays where it is - that is the point of the choice
        // being session state, with `lastOrganizationId` only deciding where a *new* session starts.
        if (sessionToken != null) {
            await setSessionActiveOrg(this.auth, sessionToken, organizationId);
        }

        this.analytics.capture(user.id, "organization.switched", {}, { organization: organizationId });

        this.logger.info("Active organization set", { organizationId });
    }

    /**
     * Names an organization, and records that a human chose the name.
     *
     * The stamp is the point as much as the name is: an organization created from a personal email
     * address is named after whoever signed up first, and `needsNaming` keeps asking until this
     * clears it.
     */
    async rename(organizationId: string, user: ActorUser, name: string): Promise<{ name: string }> {
        this.logger.info("Renaming organization", { organizationId });

        const membership = await this.db.member.findUnique({
            where: { userId_organizationId: { userId: user.id, organizationId } },
            select: { id: true },
        });
        if (membership == null) throw new NotFoundError("You are not a member of this organization");

        // `slug` is deliberately left alone. It is unique across every organization, so deriving it
        // from a user-supplied name needs collision handling - and nothing addresses an organization
        // by slug (application URLs use the application's slug), so there is nothing to gain.
        const updated = await this.db.organization.update({
            where: { id: organizationId },
            data: { name, nameConfirmedAt: new Date() },
            select: { name: true },
        });

        this.analytics.capture(user.id, "organization.renamed", {}, { organization: organizationId });

        this.logger.info("Organization renamed", { organizationId });

        return { name: updated.name };
    }

    /**
     * Drops the user's own membership. Refused in the two cases that would strand something -
     * see {@link resolveLeaveBlockedReason} - and, when they were acting as the organization they
     * just left, moves every one of their sessions to one they still belong to.
     */
    async leave(organizationId: string, user: ActorUser, sessionToken: string | undefined): Promise<void> {
        this.logger.info("Leaving organization", { organizationId });

        const [membership, memberCount, organizationCount] = await Promise.all([
            this.db.member.findUnique({
                where: { userId_organizationId: { userId: user.id, organizationId } },
                select: { id: true },
            }),
            this.db.member.count({ where: { organizationId } }),
            this.db.member.count({ where: { userId: user.id } }),
        ]);

        if (membership == null) throw new NotFoundError("You are not a member of this organization");

        const blocked = resolveLeaveBlockedReason({ organizationCount, memberCount });
        if (blocked === "last-organization") {
            throw new BadRequestError(
                "This is your only organization. Join or create another one before leaving this one.",
            );
        }
        if (blocked === "last-member") {
            throw new BadRequestError(
                "You're the last member of this organization. Invite someone else before leaving, or nobody will be able to reach its applications.",
            );
        }

        await this.db.member.delete({ where: { id: membership.id } });

        await this.evictSessionsFromOrg(user.id, organizationId, sessionToken);

        this.analytics.capture(user.id, "organization.left", {}, { organization: organizationId });

        this.logger.info("Left organization", { organizationId });
    }

    async preview(invitationId: string, user: ActorUser): Promise<InvitationPreview> {
        this.logger.info("Previewing invitation", { extra: { invitationId } });

        const invitation = await this.db.invitation.findUnique({
            where: { id: invitationId },
            select: {
                id: true,
                email: true,
                status: true,
                expiresAt: true,
                organizationId: true,
                organization: { select: { name: true } },
                inviter: { select: { name: true, email: true } },
            },
        });

        if (invitation == null) throw new NotFoundError("Invitation not found");

        const outcome = await this.resolveOutcome(invitation, user);

        this.logger.info("Previewed invitation", { extra: { invitationId, outcome } });

        return {
            invitationId: invitation.id,
            organizationName: invitation.organization.name,
            inviterName: invitation.inviter.name.length > 0 ? invitation.inviter.name : invitation.inviter.email,
            invitedEmail: invitation.email,
            outcome,
        };
    }

    /**
     * Adds a membership in the inviting organization and points this session at it. Nothing the
     * user already belonged to is touched - an account can hold several memberships, and which
     * one it is acting as is a property of the session (`activeOrganizationId`), not of the user.
     */
    async accept(invitationId: string, user: ActorUser, sessionToken: string | undefined): Promise<{ slug: string }> {
        this.logger.info("Accepting invitation", { extra: { invitationId } });

        const { organizationId, slug } = await this.db.$transaction(async (tx) => {
            const invitation = await tx.invitation.findUnique({
                where: { id: invitationId },
                select: {
                    id: true,
                    email: true,
                    status: true,
                    expiresAt: true,
                    organizationId: true,
                    organization: { select: { slug: true } },
                },
            });

            if (invitation == null) throw new NotFoundError("Invitation not found");
            if (invitation.status !== STATUS.pending) {
                throw new BadRequestError("This invitation is no longer valid.");
            }
            if (invitation.expiresAt.getTime() <= Date.now()) {
                throw new BadRequestError("This invitation has expired. Ask for a new one.");
            }
            if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
                throw new BadRequestError(
                    `This invitation was sent to ${invitation.email}. Sign in as that user to accept it.`,
                );
            }

            await tx.member.upsert({
                where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } },
                update: {},
                create: { userId: user.id, organizationId: invitation.organizationId, role: INVITED_ROLE },
            });

            await tx.invitation.update({
                where: { id: invitation.id },
                data: { status: STATUS.accepted },
            });

            return { organizationId: invitation.organizationId, slug: invitation.organization.slug };
        });

        await Promise.all([
            ensureBillingProvisioning(this.db, organizationId),
            // Accepting is a deliberate choice to work here, so it becomes where new sessions start.
            this.db.user.update({ where: { id: user.id }, data: { lastOrganizationId: organizationId } }),
        ]);

        // Only the session that accepted. Yanking every session the account holds would drag a
        // second browser out of an organization it is still a member of and actively working in.
        if (sessionToken != null) {
            await setSessionActiveOrg(this.auth, sessionToken, organizationId);
        }

        this.analytics.capture(
            user.id,
            "organization.invite_accepted",
            { extra: { invitationId } },
            { organization: organizationId },
        );

        this.logger.info("Invitation accepted", { organizationId, extra: { invitationId } });

        return { slug };
    }

    async decline(invitationId: string, user: ActorUser): Promise<void> {
        this.logger.info("Declining invitation", { extra: { invitationId } });

        const invitation = await this.db.invitation.findUnique({
            where: { id: invitationId },
            select: { id: true, email: true, status: true, organizationId: true },
        });

        if (invitation == null) throw new NotFoundError("Invitation not found");
        if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
            throw new NotFoundError("Invitation not found");
        }
        if (invitation.status !== STATUS.pending) {
            throw new BadRequestError("This invitation is no longer valid.");
        }

        await this.db.invitation.update({
            where: { id: invitation.id },
            data: { status: STATUS.rejected },
        });

        this.analytics.capture(
            user.id,
            "organization.invite_declined",
            { extra: { invitationId } },
            { organization: invitation.organizationId },
        );

        this.logger.info("Invitation declined", { extra: { invitationId } });
    }

    private acceptUrl(invitationId: string): string {
        return `${this.appUrl}/invite/${invitationId}`;
    }

    private async resolveOutcome(
        invitation: { email: string; status: string; expiresAt: Date; organizationId: string },
        user: ActorUser,
    ): Promise<InvitationOutcome> {
        const alreadyMember = await this.db.member.findUnique({
            where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } },
            select: { id: true },
        });
        if (alreadyMember != null) return "already-member";

        if (invitation.status === STATUS.accepted) return "accepted";
        if (invitation.status === STATUS.rejected) return "declined";
        if (invitation.status === STATUS.canceled) return "revoked";
        if (invitation.expiresAt.getTime() <= Date.now()) return "expired";
        if (invitation.email.toLowerCase() !== user.email.toLowerCase()) return "wrong-account";

        return "joinable";
    }

    /**
     * Gets a user out of an organization they no longer belong to, across every session they hold.
     *
     * This is the security-relevant half of losing a membership. `protectedProcedure` authorizes on
     * `session.activeOrganizationId` and never re-checks the `member` row, so a session left pointing
     * at the lost organization keeps full access to it for the rest of its lifetime - days, not
     * minutes. Deleting the membership alone does not end access.
     *
     * Sessions acting as some *other* organization are left alone; only the ones aimed at the lost
     * organization move, to whichever membership remains. With no membership left at all there is
     * nowhere to send them, so those sessions are revoked outright rather than left pointing at an
     * organization the user is no longer in.
     */
    private async evictSessionsFromOrg(
        userId: string,
        lostOrganizationId: string,
        currentSessionToken?: string,
    ): Promise<void> {
        const ctx = await this.auth.$context;
        const [sessions, fallback] = await Promise.all([
            ctx.internalAdapter.listSessions(userId),
            this.db.member.findFirst({
                where: { userId },
                select: { organizationId: true },
                orderBy: { createdAt: "asc" },
            }),
            // The foreign key clears this only when the organization is deleted, not when the user
            // stops being a member of one that still exists - so drop it here, or a new session
            // would try to start somewhere they can no longer go.
            this.db.user.updateMany({
                where: { id: userId, lastOrganizationId: lostOrganizationId },
                data: { lastOrganizationId: null },
            }),
        ]);

        // The caller's own token is included explicitly: a session created outside better-auth's
        // endpoints may not be listed, and it is the one session guaranteed to be looking at this org.
        const tokens = new Set(sessions.map((session) => session.token));
        if (currentSessionToken != null) tokens.add(currentSessionToken);

        if (fallback == null) {
            await Promise.all([...tokens].map((token) => ctx.internalAdapter.deleteSession(token)));
            this.logger.info("Revoked sessions after last membership was removed", {
                organizationId: lostOrganizationId,
                extra: { count: tokens.size },
            });
            return;
        }

        await Promise.all(
            [...tokens].map((token) =>
                setSessionActiveOrg(this.auth, token, fallback.organizationId, lostOrganizationId),
            ),
        );

        this.logger.info("Moved sessions off the lost organization", {
            organizationId: fallback.organizationId,
            extra: { lostOrganizationId, count: tokens.size },
        });
    }
}
