import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { isConsumerEmailDomain } from "@autonoma/types";
import { findOrganizationByDomain } from "./upsert-organization-for-signup";

export interface SignupOrganizationKey {
    /** The value `Organization.domain` is keyed on. */
    key: string;
    /**
     * True when the key is a bare domain, which is what makes it an auto-join key: later signups at
     * the same domain land in this organization. False when the key is a whole email address, which
     * nothing else can match.
     */
    autoJoin: boolean;
}

export interface SignupOrganizationKeyParams {
    /** The full address, used as the key when the organization must not be auto-joinable. */
    email: string;
    /** Its domain, used as the key when it may be. */
    domain: string;
    /**
     * What the identity provider asserted: true for a domain it administers, false for a personal
     * account, undefined when it asserted nothing.
     */
    assertedCompany?: boolean;
}

/**
 * Decides what a new signup's organization is keyed on - which is the same as deciding whether anyone
 * else at that domain will later be dropped into it.
 *
 * **A new auto-join key is only ever minted on proof.** Before this, "looks like a company domain"
 * was enough, where "looks like" meant "is not on our list of consumer providers". That list cannot be
 * completed - a personal domain hosted on Proton or Fastmail is indistinguishable from a company's,
 * and a domain thousands of strangers share need not be a mailbox provider at all - and it failed in
 * the expensive direction: a provider nobody had added pooled strangers into one organization as its
 * owners. Requiring an assertion inverts that. The worst an absent assertion can now do is give
 * colleagues separate organizations, which an invitation fixes.
 *
 * An **existing** bare-domain organization is still joined. Those were either created from an
 * assertion, or predate this rule and are grandfathered - 516 of them at the time of writing, and
 * breaking their teams to close a hole they are not part of would be a poor trade. It does mean a
 * pre-existing bad key keeps auto-joining, so the audit that removed the consumer-provider ones stays
 * relevant.
 */
export async function resolveSignupOrganizationKey(
    conn: PrismaClient,
    { email, domain, assertedCompany }: SignupOrganizationKeyParams,
): Promise<SignupOrganizationKey> {
    const logger = rootLogger.child({ name: "resolveSignupOrganizationKey" });

    if (assertedCompany === true) {
        logger.info("Provider vouched for the domain; keying on it");
        return { key: domain, autoJoin: true };
    }
    if (assertedCompany === false) {
        logger.info("Provider called this a personal account; keying on the address");
        return { key: email, autoJoin: false };
    }

    // No assertion. The list is still worth consulting, but only to skip the lookup below for a
    // domain we already know is a mailbox provider.
    if (isConsumerEmailDomain(domain)) {
        logger.info("Known consumer provider; keying on the address");
        return { key: email, autoJoin: false };
    }

    const existing = await findOrganizationByDomain(conn, domain);
    if (existing != null) {
        logger.info("Joining the organization already keyed on this domain", { organizationId: existing.id });
        return { key: domain, autoJoin: true };
    }

    logger.info("Nobody vouched for this domain and no organization holds it; keying on the address");
    return { key: email, autoJoin: false };
}
