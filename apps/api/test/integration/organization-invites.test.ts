import { randomBytes } from "node:crypto";
import type { PrismaClient, Session, User } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueEmail(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}@example.com`;
}

/**
 * A user who owns their own single-member organization - the shape every personal-email signup
 * lands in, and therefore the interesting case for accepting an invitation: they end up in two.
 */
async function createUserWithOwnOrg(
    db: PrismaClient,
    options: { email?: string; applicationCount?: number } = {},
): Promise<{ user: User; session: Session; organizationId: string }> {
    const email = options.email ?? uniqueEmail("invitee");

    const user = await db.user.create({
        data: { name: "Invitee", email, emailVerified: true },
    });
    // `domain` is the user's own email address: nobody is auto-joined, so the org needs invites.
    const organization = await db.organization.create({
        data: {
            name: `Org ${randomBytes(3).toString("hex")}`,
            slug: `org-${randomBytes(4).toString("hex")}`,
            domain: email,
        },
    });
    await db.member.create({ data: { userId: user.id, organizationId: organization.id, role: "owner" } });

    for (let index = 0; index < (options.applicationCount ?? 0); index += 1) {
        await db.application.create({
            data: {
                name: `App ${index}`,
                slug: `app-${randomBytes(4).toString("hex")}`,
                architecture: "WEB",
                organizationId: organization.id,
            },
        });
    }

    const session = await db.session.create({
        data: {
            token: `session-${randomBytes(8).toString("hex")}`,
            expiresAt: new Date(Date.now() + DAY_MS),
            userId: user.id,
            activeOrganizationId: organization.id,
        },
    });

    return { user, session, organizationId: organization.id };
}

/**
 * The single internal organization, created on first use. `organization.domain` is unique, and in
 * production exactly one org is keyed on the internal domain - so tests share it rather than each
 * making their own, which collides on that constraint.
 */
async function ensureInternalOrg(db: PrismaClient, internalDomain: string) {
    return db.organization.upsert({
        where: { domain: internalDomain },
        update: {},
        create: { name: "Autonoma", slug: `internal-${randomBytes(4).toString("hex")}`, domain: internalDomain },
    });
}

async function inviteTo(harness: APITestHarness, email: string) {
    return await harness.request().organization.invite({ email });
}

apiTestSuite({
    name: "organization-invites",
    seed: async ({ harness }) => {
        await harness.db.member.create({
            data: { userId: harness.userId, organizationId: harness.organizationId, role: "owner" },
        });
        return {};
    },
    cases: (test) => {
        test("invite creates a pending invitation and mails an accept link", async ({ harness }) => {
            const email = uniqueEmail("new");
            const invitation = await inviteTo(harness, email);

            expect(invitation.email).toBe(email);
            expect(invitation.acceptUrl).toContain(`/invite/${invitation.id}`);
            expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());

            const pending = await harness.request().organization.invitations();
            expect(pending.map((row) => row.email)).toContain(email);

            const mail = harness.emailSender.sent.find((sent) => sent.to === email);
            expect(mail?.html).toContain(invitation.acceptUrl);
        });

        test("the invitation comes from the product, not the environment's default sender", async ({ harness }) => {
            // The default sender also sends the onboarding email, which is deliberately from a person.
            // An invitation arriving from that address reads as a mistake, so invitations carry their own.
            const email = uniqueEmail("branded");
            await inviteTo(harness, email);

            const mail = harness.emailSender.sent.find((sent) => sent.to === email);
            expect(mail?.from).toBe(harness.invitesFromEmail);
            expect(mail?.from).toMatch(/^Autonoma </);
        });

        test("an invitation survives a mail provider failure", async ({ harness }) => {
            const email = uniqueEmail("mail-down");
            harness.emailSender.failNextSend = true;

            const invitation = await inviteTo(harness, email);

            // The row is what makes the link work, so a dead provider must not lose it.
            const pending = await harness.request().organization.invitations();
            expect(pending.map((row) => row.id)).toContain(invitation.id);
        });

        test("re-inviting the same address refreshes one row instead of duplicating", async ({ harness }) => {
            const email = uniqueEmail("twice");
            const first = await inviteTo(harness, email);
            const second = await inviteTo(harness, email);

            expect(second.id).toBe(first.id);
            expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime());

            const rows = await harness.db.invitation.findMany({
                where: { organizationId: harness.organizationId, email },
            });
            expect(rows).toHaveLength(1);
        });

        test("inviting an existing member is refused", async ({ harness }) => {
            const member = await harness.db.user.create({
                data: { name: "Already In", email: uniqueEmail("member"), emailVerified: true },
            });
            await harness.db.member.create({
                data: { userId: member.id, organizationId: harness.organizationId, role: "member" },
            });

            await expect(inviteTo(harness, member.email)).rejects.toThrow(/already a member/i);
        });

        /**
         * A domain-keyed organization acting as the caller. `domain` is unique, so it is randomised per
         * run - a hardcoded value passes once and then collides with the previous run's row.
         */
        async function domainKeyedOrgSession(harness: APITestHarness) {
            const domain = `acme-${randomBytes(4).toString("hex")}.test`;
            const org = await harness.db.organization.create({
                data: { name: "Acme", slug: `acme-${randomBytes(4).toString("hex")}`, domain },
            });
            await harness.db.member.create({
                data: { userId: harness.userId, organizationId: org.id, role: "owner" },
            });
            const session = await harness.db.session.create({
                data: {
                    token: `session-${randomBytes(8).toString("hex")}`,
                    expiresAt: new Date(Date.now() + DAY_MS),
                    userId: harness.userId,
                    activeOrganizationId: org.id,
                },
            });
            return { domain, org, session };
        }

        test("inviting an address at the organization's own auto-join domain is refused as pointless", async ({
            harness,
        }) => {
            const { domain, session } = await domainKeyedOrgSession(harness);

            // This person is auto-joined the moment they sign up, so an invitation adds nothing.
            await expect(
                harness
                    .request(session)
                    .organization.invite({ email: `newcomer-${randomBytes(4).toString("hex")}@${domain}` }),
            ).rejects.toThrow(/automatically/i);
        });

        test("a domain-keyed organization can invite someone from outside its domain", async ({ harness }) => {
            // The defect this replaced: every invitation from a domain-keyed organization was refused,
            // so a company could not invite a contractor on gmail, anyone at a partner company, or a
            // founder's own personal address - the only people who actually need an invitation.
            const { session } = await domainKeyedOrgSession(harness);
            const outsider = uniqueEmail("contractor");

            const invitation = await harness.request(session).organization.invite({ email: outsider });

            expect(invitation.email).toBe(outsider);
            expect(invitation.acceptUrl).toContain(`/invite/${invitation.id}`);
        });

        test("accepting adds a membership and keeps the ones the user already had", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);

            const result = await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            expect(result.slug).toBeTruthy();

            const organizationIds = (await harness.db.member.findMany({ where: { userId: invitee.user.id } })).map(
                (member) => member.organizationId,
            );
            expect(organizationIds).toContain(harness.organizationId);
            expect(organizationIds).toContain(invitee.organizationId);

            const row = await harness.db.invitation.findUnique({ where: { id: invitation.id } });
            expect(row?.status).toBe("accepted");
        });

        test("mine lists every organization the account belongs to, flagging the active one", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db, { applicationCount: 2 });
            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            const organizations = await harness.request(invitee.session, invitee.user).organization.mine();

            expect(organizations.map((org) => org.id)).toEqual(
                expect.arrayContaining([invitee.organizationId, harness.organizationId]),
            );

            const own = organizations.find((org) => org.id === invitee.organizationId);
            expect(own?.applicationCount).toBe(2);
            // Sole member of their own org, so leaving it would strand those two applications.
            expect(own?.leaveBlockedReason).toBe("last-member");

            // The session still points at the org they came from - `mine` reports it, it does not change it.
            expect(organizations.filter((org) => org.isActive)).toHaveLength(1);
        });

        test("leaving an organization drops only that membership and moves the session off it", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            // A second member, so leaving is not refused for stranding the org.
            const colleague = await harness.db.user.create({
                data: { name: "Colleague", email: uniqueEmail("colleague"), emailVerified: true },
            });
            await harness.db.member.create({
                data: { userId: colleague.id, organizationId: invitee.organizationId, role: "member" },
            });

            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            await harness
                .request(invitee.session, invitee.user)
                .organization.leave({ organizationId: invitee.organizationId });

            const organizationIds = (await harness.db.member.findMany({ where: { userId: invitee.user.id } })).map(
                (member) => member.organizationId,
            );
            expect(organizationIds).toEqual([harness.organizationId]);
        });

        test("leaving your only organization is refused", async ({ harness }) => {
            const solo = await createUserWithOwnOrg(harness.db);

            await expect(
                harness.request(solo.session, solo.user).organization.leave({ organizationId: solo.organizationId }),
            ).rejects.toThrow(/only organization/i);
        });

        test("leaving an organization you are the last member of is refused", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db, { applicationCount: 1 });
            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            // Two organizations now, so `last-organization` does not fire - but they are still the
            // only member of their own, and leaving would make its application unreachable.
            await expect(
                harness
                    .request(invitee.session, invitee.user)
                    .organization.leave({ organizationId: invitee.organizationId }),
            ).rejects.toThrow(/last member/i);
        });

        test("a signed-in user whose email does not match cannot accept", async ({ harness }) => {
            const other = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, uniqueEmail("someone-else"));

            const preview = await harness
                .request(other.session, other.user)
                .organization.invitation({ invitationId: invitation.id });
            expect(preview.outcome).toBe("wrong-account");

            await expect(
                harness.request(other.session, other.user).organization.acceptInvitation({
                    invitationId: invitation.id,
                }),
            ).rejects.toThrow(/sent to/i);

            const memberships = await harness.db.member.findMany({ where: { userId: other.user.id } });
            expect(memberships).toHaveLength(1);
            expect(memberships[0]?.organizationId).toBe(other.organizationId);
        });

        test("an expired invitation cannot be accepted", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);
            await harness.db.invitation.update({
                where: { id: invitation.id },
                data: { expiresAt: new Date(Date.now() - DAY_MS) },
            });

            const caller = harness.request(invitee.session, invitee.user);
            expect((await caller.organization.invitation({ invitationId: invitation.id })).outcome).toBe("expired");
            await expect(caller.organization.acceptInvitation({ invitationId: invitation.id })).rejects.toThrow(
                /expired/i,
            );
        });

        test("a revoked invitation cannot be accepted", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);

            await harness.request().organization.revokeInvitation({ invitationId: invitation.id });

            const caller = harness.request(invitee.session, invitee.user);
            expect((await caller.organization.invitation({ invitationId: invitation.id })).outcome).toBe("revoked");
            await expect(caller.organization.acceptInvitation({ invitationId: invitation.id })).rejects.toThrow(
                /no longer valid/i,
            );

            const memberships = await harness.db.member.findMany({ where: { userId: invitee.user.id } });
            expect(memberships[0]?.organizationId).toBe(invitee.organizationId);
        });

        test("revoking an invitation belonging to another organization is refused", async ({ harness }) => {
            const outsider = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, uniqueEmail("target"));

            await expect(
                harness
                    .request(outsider.session, outsider.user)
                    .organization.revokeInvitation({ invitationId: invitation.id }),
            ).rejects.toThrow(/not found/i);

            const row = await harness.db.invitation.findUnique({ where: { id: invitation.id } });
            expect(row?.status).toBe("pending");
        });

        test("declining leaves the user where they were", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);

            await harness
                .request(invitee.session, invitee.user)
                .organization.declineInvitation({ invitationId: invitation.id });

            const row = await harness.db.invitation.findUnique({ where: { id: invitation.id } });
            expect(row?.status).toBe("rejected");

            const memberships = await harness.db.member.findMany({ where: { userId: invitee.user.id } });
            expect(memberships).toHaveLength(1);
            expect(memberships[0]?.organizationId).toBe(invitee.organizationId);
        });

        test("accepting a third invitation keeps all of them", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const third = await harness.db.organization.create({
                data: { name: "Third", slug: `third-${randomBytes(4).toString("hex")}` },
            });
            await harness.db.member.create({
                data: { userId: invitee.user.id, organizationId: third.id, role: "member" },
            });

            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            const organizationIds = (await harness.db.member.findMany({ where: { userId: invitee.user.id } })).map(
                (member) => member.organizationId,
            );
            expect(organizationIds).toHaveLength(3);
            expect(organizationIds).toEqual(
                expect.arrayContaining([invitee.organizationId, third.id, harness.organizationId]),
            );
        });

        test("removing a member ends their access, not just their membership row", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            await harness.request().organization.removeMember({ userId: invitee.user.id });

            // Deleting the membership alone would leave their session acting as this org for days,
            // because `protectedProcedure` authorizes on the session's active org and never re-checks
            // membership. The remembered choice has to go with it.
            const user = await harness.db.user.findUnique({ where: { id: invitee.user.id } });
            expect(user?.lastOrganizationId).not.toBe(harness.organizationId);
        });

        test("setActive remembers the organization for the next session", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            await harness
                .request(invitee.session, invitee.user)
                .organization.setActive({ organizationId: invitee.organizationId });

            const user = await harness.db.user.findUnique({ where: { id: invitee.user.id } });
            expect(user?.lastOrganizationId).toBe(invitee.organizationId);
        });

        test("setActive on an organization you are not in is refused", async ({ harness }) => {
            const outsider = await createUserWithOwnOrg(harness.db);

            await expect(
                harness
                    .request(outsider.session, outsider.user)
                    .organization.setActive({ organizationId: harness.organizationId }),
            ).rejects.toThrow(/not a member/i);
        });

        test("renaming stamps the name as confirmed so it stops being asked for", async ({ harness }) => {
            const before = await harness.db.organization.findUnique({ where: { id: harness.organizationId } });
            expect(before?.nameConfirmedAt).toBeNull();

            const result = await harness
                .request()
                .organization.rename({ organizationId: harness.organizationId, name: "Northwind Traders" });

            expect(result.name).toBe("Northwind Traders");

            const after = await harness.db.organization.findUnique({ where: { id: harness.organizationId } });
            expect(after?.nameConfirmedAt).not.toBeNull();
            // The slug is deliberately untouched - it is globally unique and nothing addresses an
            // organization by it.
            expect(after?.slug).toBe(before?.slug);
        });

        test("renaming an organization you are not in is refused", async ({ harness }) => {
            const outsider = await createUserWithOwnOrg(harness.db);

            await expect(
                harness
                    .request(outsider.session, outsider.user)
                    .organization.rename({ organizationId: harness.organizationId, name: "Not Mine" }),
            ).rejects.toThrow(/not a member/i);
        });

        test("appSlugOwners lists only the caller's own organizations that own the slug", async ({ harness }) => {
            const member = await createUserWithOwnOrg(harness.db);
            const slug = `shared-${randomBytes(4).toString("hex")}`;

            const strangerOrg = await harness.db.organization.create({
                data: { name: "Stranger", slug: `stranger-${randomBytes(4).toString("hex")}` },
            });
            for (const organizationId of [member.organizationId, strangerOrg.id]) {
                await harness.db.application.create({
                    data: { name: slug, slug, architecture: "WEB", organizationId },
                });
            }

            const owners = await harness
                .request(member.session, member.user)
                .organization.appSlugOwners({ appSlug: slug });

            // Their own organization, and nothing about the one they have no membership in.
            expect(owners.map((owner) => owner.organizationId)).toEqual([member.organizationId]);
        });

        test("appSlugOwners hides a disabled application", async ({ harness }) => {
            const member = await createUserWithOwnOrg(harness.db);
            const slug = `gone-${randomBytes(4).toString("hex")}`;
            await harness.db.application.create({
                data: {
                    name: slug,
                    slug,
                    architecture: "WEB",
                    organizationId: member.organizationId,
                    disabled: true,
                },
            });

            const owners = await harness
                .request(member.session, member.user)
                .organization.appSlugOwners({ appSlug: slug });

            expect(owners).toHaveLength(0);
        });

        test("appSlugOwners prefers a customer org over the internal one that dogfoods the slug", async ({
            harness,
        }) => {
            const slug = `dogfood-${randomBytes(4).toString("hex")}`;
            const staff = await createUserWithOwnOrg(harness.db);

            // The internal org dogfoods customer applications, so the same slug lives in both, and staff
            // are members of the internal org. A membership-scoped lookup therefore sees both and must
            // still prefer the customer's copy - otherwise a shared link opens our clone of their app.
            const internalOrg = await ensureInternalOrg(harness.db, harness.internalDomain);
            const customerOrg = await harness.db.organization.create({
                data: {
                    name: "Customer",
                    slug: `customer-${randomBytes(4).toString("hex")}`,
                    domain: `customer-${randomBytes(3).toString("hex")}.example`,
                },
            });
            for (const organizationId of [internalOrg.id, customerOrg.id]) {
                await harness.db.member.upsert({
                    where: { userId_organizationId: { userId: staff.user.id, organizationId } },
                    update: {},
                    create: { userId: staff.user.id, organizationId, role: "member" },
                });
                await harness.db.application.create({
                    data: { name: slug, slug, architecture: "WEB", organizationId },
                });
            }

            const owners = await harness
                .request(staff.session, staff.user)
                .organization.appSlugOwners({ appSlug: slug });

            expect(owners.map((owner) => owner.organizationId)).toEqual([customerOrg.id]);
        });

        test("appSlugOwners still returns the internal org when it is the only owner", async ({ harness }) => {
            const slug = `internal-only-${randomBytes(4).toString("hex")}`;
            const staff = await createUserWithOwnOrg(harness.db);
            const internalOrg = await ensureInternalOrg(harness.db, harness.internalDomain);
            await harness.db.member.upsert({
                where: { userId_organizationId: { userId: staff.user.id, organizationId: internalOrg.id } },
                update: {},
                create: { userId: staff.user.id, organizationId: internalOrg.id, role: "member" },
            });
            await harness.db.application.create({
                data: { name: slug, slug, architecture: "WEB", organizationId: internalOrg.id },
            });

            const owners = await harness
                .request(staff.session, staff.user)
                .organization.appSlugOwners({ appSlug: slug });

            // Filtering the internal org unconditionally would make an internal-only app unreachable.
            expect(owners.map((owner) => owner.organizationId)).toEqual([internalOrg.id]);
        });

        test("removing yourself is refused", async ({ harness }) => {
            await expect(harness.request().organization.removeMember({ userId: harness.userId })).rejects.toThrow(
                /remove yourself/i,
            );
        });

        test("removing another member drops only their membership", async ({ harness }) => {
            const invitee = await createUserWithOwnOrg(harness.db);
            const invitation = await inviteTo(harness, invitee.user.email);
            await harness
                .request(invitee.session, invitee.user)
                .organization.acceptInvitation({ invitationId: invitation.id });

            await harness.request().organization.removeMember({ userId: invitee.user.id });

            const members = await harness.request().organization.members();
            expect(members.map((member) => member.userId)).not.toContain(invitee.user.id);
            expect(members.map((member) => member.userId)).toContain(harness.userId);
        });
    },
});
