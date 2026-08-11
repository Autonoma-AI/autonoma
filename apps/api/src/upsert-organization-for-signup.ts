import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

// How many times to re-attempt with a fresh slug before giving up. Each attempt after the first uses a
// random suffix, so two is already enough in practice; the extras cost nothing on the happy path.
const SLUG_ATTEMPTS = 5;
const SLUG_SUFFIX_BYTES = 3;
// `Organization.slug` is part of a URL and cannot be empty. A display name of only non-ASCII characters
// slugifies to "", so there has to be something to fall back to.
const FALLBACK_SLUG = "org";
const UNIQUE_CONSTRAINT_CODE = "P2002";

export interface ResolvedOrganization {
    id: string;
    name: string;
    slug: string;
}

export interface SignupOrganization {
    /**
     * The value `Organization.domain` is keyed on: a company's email domain when its provider vouched
     * for it, or a whole email address when nobody did and the next signup at the same domain could be
     * a stranger. See `resolveSignupOrganizationKey`.
     *
     * Case is normalized here rather than at the call site, because getting it wrong in either
     * direction is a defect: two spellings of one company domain split colleagues into separate
     * organizations, and a caller that lowercased only one of the two keys would disagree with itself.
     */
    domain: string;
    name: string;
    /** Slug to use when it is free. A random suffix is appended when another organization holds it. */
    preferredSlug: string;
    /** Set for a name that needs no confirming - one derived from a company's own domain. */
    nameConfirmedAt?: Date;
}

/**
 * Finds or creates the organization a signup belongs to, keyed on its email domain.
 *
 * The slug retry exists because `Organization.slug` is unique across the whole table while the slug for
 * a personal-email signup is derived from nothing but the person's display name. Two people who happen
 * to share a name - "John Smith" from two different Gmail addresses - derive the same slug, and without
 * this the second one's sign-in died on a unique-constraint violation with no way for them to get past
 * it. A suffix costs that person a slightly uglier slug; the alternative was being unable to sign up.
 *
 * Re-attempting also settles the other race this can lose: two sign-ins for the same brand-new domain
 * arriving together both find nothing and both insert. Going round again reads the winner's row rather
 * than creating a duplicate.
 */
export async function upsertOrganizationForSignup(
    conn: PrismaClient,
    org: SignupOrganization,
): Promise<ResolvedOrganization> {
    const logger = rootLogger.child({ name: "upsertOrganizationForSignup" });
    const domain = org.domain.trim().toLowerCase();
    const base = org.preferredSlug.length > 0 ? org.preferredSlug : FALLBACK_SLUG;

    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
        const existing = await findOrganizationByDomain(conn, domain);
        if (existing != null) {
            logger.info("Joined existing organization", { organizationId: existing.id });
            return existing;
        }

        const slug = attempt === 0 ? base : `${base}-${randomBytes(SLUG_SUFFIX_BYTES).toString("hex")}`;
        try {
            const created = await conn.organization.create({
                data: {
                    name: org.name,
                    slug,
                    domain,
                    status: "approved",
                    nameConfirmedAt: org.nameConfirmedAt,
                },
                select: { id: true, name: true, slug: true },
            });
            logger.info("Created organization for signup", { organizationId: created.id, extra: { slug } });
            return created;
        } catch (err) {
            // Two uniques can bite here, and both are answered by going round again: `slug`, which is
            // the collision this function exists for, and `domain`, when a concurrent sign-in for the
            // same new domain inserted between the read above and this write. The next iteration
            // re-reads, so the domain race resolves to the winner's row.
            if (!isUniqueConstraintViolation(err)) throw err;
            logger.warn("Organization slug or domain was taken; re-attempting", {
                extra: { slug, attempt, domain },
            });
        }
    }

    throw new Error(`Could not find a free organization slug for "${base}" after ${SLUG_ATTEMPTS} attempts`);
}

/**
 * The organization keyed on this domain, matched case-insensitively.
 *
 * The exact-match read comes first because it is the overwhelmingly common case and it uses the unique
 * index. The insensitive fallback is only for rows written before the key was normalized: without it a
 * legacy `Acme.com` row would not be found by `acme.com`, and the next colleague to sign in would get a
 * second organization rather than joining the one their team is already in.
 */
async function findOrganizationByDomain(conn: PrismaClient, domain: string): Promise<ResolvedOrganization | undefined> {
    const select = { id: true, name: true, slug: true };
    const exact = await conn.organization.findUnique({ where: { domain }, select });
    if (exact != null) return exact;

    const insensitive = await conn.organization.findFirst({
        where: { domain: { equals: domain, mode: "insensitive" } },
        select,
    });
    return insensitive ?? undefined;
}

/**
 * Whether this is Prisma's unique-constraint error, read structurally rather than with `instanceof`:
 * the error crosses the driver-adapter boundary, and the class identity a bundled `@prisma/client`
 * hands back is not reliably the one an `instanceof` here would compare against.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
    if (typeof err !== "object" || err == null) return false;
    return Reflect.get(err, "code") === UNIQUE_CONSTRAINT_CODE;
}
