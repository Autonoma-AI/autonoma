import type { PrismaClient } from "@autonoma/db";
import { CreditTransactionType } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

/** An organization whose starting grant this address has already had the benefit of. */
export interface GrantedOrganization {
    id: string;
    name: string;
}

export interface FreeStartEligibility {
    eligible: boolean;
    /**
     * The organizations that spent the entitlement, empty when eligible. The UI names them, because
     * "you don't get free credits" is only answerable with "because you already have them over there".
     */
    blockedBy: GrantedOrganization[];
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/**
 * Whether this address is still entitled to the free starting credits.
 *
 * The credits sit on an organization but the entitlement belongs to a person, and that difference is
 * what made them farmable: anything that lets somebody reach a new organization - a Vercel team
 * install - reaches another full starting balance. Capping per organization cannot see that.
 *
 * Recorded on a list rather than computed from memberships, because a computed answer is reversible:
 * leave the organization and you are entitled again. The list is written when a grant is made and when
 * somebody joins an organization that holds one, so it also covers the expensive version - one person
 * takes the grant, invites nine colleagues, and each of them creates a Vercel team for another balance.
 * Nine people who never personally received a grant are nine grants.
 *
 * Keyed on the address, not a user id: deleting an account and signing up again mints a new id for the
 * same human, which would reset a per-user cap for free.
 */
export async function resolveFreeStartEligibility(db: PrismaClient, email: string): Promise<FreeStartEligibility> {
    const logger = rootLogger.child({ name: "resolveFreeStartEligibility" });

    const record = await db.freeStartIneligibility.findUnique({
        where: { email: normalizeEmail(email) },
        select: { organizationIds: true },
    });

    if (record == null) {
        logger.info("Address is entitled to the free starting credits");
        return { eligible: true, blockedBy: [] };
    }

    // Named for the UI. Organizations are not deleted, but a missing one must not turn an explanation
    // into a crash, so whatever resolves is what gets shown.
    const blockedBy = await db.organization.findMany({
        where: { id: { in: record.organizationIds } },
        select: { id: true, name: true },
    });

    logger.info("Address has already had the benefit of a starting grant", {
        extra: { organizationCount: record.organizationIds.length },
    });
    return { eligible: false, blockedBy };
}

/**
 * Claims this address's one starting grant for `organizationId`. True when this caller won it.
 *
 * Ask this instead of `resolveFreeStartEligibility` wherever a grant is about to be made, because
 * reading eligibility and then granting is two steps: two concurrent sign-ins for the same address both
 * read "entitled", and both grant a full balance. Vercel SSO is the realistic source - a browser retry
 * or two tabs is enough.
 *
 * The unique index on `email` is the mutex. Exactly one `create` can win, so exactly one caller is told
 * to grant; the loser is told not to, before any credits exist. `resolveFreeStartEligibility` stays for
 * reads that only describe the situation, like the UI.
 */
export async function claimFreeStartEntitlement(
    db: PrismaClient,
    email: string,
    organizationId: string,
): Promise<boolean> {
    const logger = rootLogger.child({ name: "claimFreeStartEntitlement" });
    const normalized = normalizeEmail(email);
    if (normalized === "") return false;

    try {
        await db.freeStartIneligibility.create({ data: { email: normalized, organizationIds: [organizationId] } });
        logger.info("Claimed the free-start entitlement", { organizationId });
        return true;
    } catch (err) {
        if (isUniqueEmailViolation(err)) {
            logger.info("Entitlement already spent, so no grant here", { organizationId });
            return false;
        }
        // Anything else is unexpected. Refusing the grant is the safe direction: a missed grant is a
        // support ticket, a wrongly repeated one is money.
        logger.error("Could not claim the free-start entitlement - refusing the grant", { organizationId, err });
        return false;
    }
}

/** Prisma's unique-constraint code, read structurally - the error crosses the driver-adapter boundary. */
function isUniqueEmailViolation(err: unknown): boolean {
    if (typeof err !== "object" || err == null) return false;
    return Reflect.get(err, "code") === "P2002";
}

/**
 * Records that this address has had the benefit of `organizationId`'s starting grant.
 *
 * Idempotent and additive: a second call for the same address appends the organization rather than
 * replacing the history, so the UI can name every organization involved.
 *
 * Best-effort by design. Losing this write means somebody keeps an entitlement they have spent, which
 * costs credits; failing the sign-in or the invitation that triggered it costs a customer. The cheaper
 * mistake is the one that gets made, and it is logged loudly.
 */
export async function recordFreeStartIneligibility(
    db: PrismaClient,
    email: string,
    organizationId: string,
    /**
     * The internal email domain, whose addresses are never recorded. Staff hold memberships in customer
     * organizations through `admin.switchToOrg` - that is looking at an account, not spending a trial,
     * and marking them would deny them one for real work later.
     */
    internalDomain?: string,
): Promise<void> {
    const logger = rootLogger.child({ name: "recordFreeStartIneligibility" });
    const normalized = normalizeEmail(email);
    if (normalized === "") return;
    if (internalDomain != null && normalized.endsWith(`@${normalizeEmail(internalDomain)}`)) {
        logger.info("Staff address, not recording a spent entitlement", { organizationId });
        return;
    }

    try {
        const existing = await db.freeStartIneligibility.findUnique({
            where: { email: normalized },
            select: { organizationIds: true },
        });

        if (existing == null) {
            await db.freeStartIneligibility.create({
                data: { email: normalized, organizationIds: [organizationId] },
            });
            logger.info("Recorded a spent free-start entitlement", { organizationId });
            return;
        }

        if (existing.organizationIds.includes(organizationId)) return;

        await db.freeStartIneligibility.update({
            where: { email: normalized },
            data: { organizationIds: { push: organizationId } },
        });
        logger.info("Added an organization to a spent free-start entitlement", { organizationId });
    } catch (err) {
        logger.error("Could not record a spent free-start entitlement - the address keeps its entitlement", {
            organizationId,
            err,
        });
    }
}

/** Whether this organization holds a starting grant, i.e. joining it spends the joiner's entitlement. */
export async function organizationHoldsFreeStartGrant(db: PrismaClient, organizationId: string): Promise<boolean> {
    const grant = await db.creditTransaction.findFirst({
        where: { organizationId, type: CreditTransactionType.FREE_START_GRANT },
        select: { id: true },
    });
    return grant != null;
}
