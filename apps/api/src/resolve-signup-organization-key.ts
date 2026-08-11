import { logger as rootLogger } from "@autonoma/logger";

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
     * account, undefined when it asserted nothing. Only `true` keys on the domain - see below.
     */
    assertedCompany?: boolean;
}

/**
 * Decides what a new signup's organization is keyed on - which is the same as deciding whether anyone
 * else at that domain will later be dropped into it.
 *
 * **An auto-join key requires the provider to vouch for the domain.** Nothing else will do. A signup
 * that arrives without an assertion - GitHub, which asserts nothing about email domains - gets its own
 * organization keyed on the whole address, and colleagues come together through an invitation or an
 * identity provider that does assert (Google Workspace, Microsoft).
 *
 * Two weaker rules used to stand in for an assertion, and both are gone. The first was "is not on our
 * list of consumer providers", which cannot be completed: a personal domain hosted on Proton is
 * indistinguishable from a company's, and a domain thousands of strangers share need not be a mailbox
 * provider at all - so a provider nobody had added pooled strangers into one organization as its
 * owners. The second was joining whatever organization already held the bare domain, which inherited
 * that same mistake: a key minted under the old rule kept auto-joining strangers indefinitely, and no
 * audit of existing keys can fix a rule that keeps honouring them.
 *
 * The cost is that colleagues who sign in without an assertion get separate organizations, which an
 * invitation fixes in one click. Pooling strangers who can read each other's applications does not have
 * a one-click fix, so this is the direction to fail in.
 */
export function resolveSignupOrganizationKey({
    email,
    domain,
    assertedCompany,
}: SignupOrganizationKeyParams): SignupOrganizationKey {
    const logger = rootLogger.child({ name: "resolveSignupOrganizationKey" });

    if (assertedCompany === true) {
        logger.info("Provider vouched for the domain; keying on it");
        return { key: domain, autoJoin: true };
    }

    // `false` and "asserted nothing" get the same answer, because neither is proof. They are kept
    // distinct in the input only so the caller's provider handling stays readable.
    logger.info("Nobody vouched for this domain; keying on the address");
    return { key: email, autoJoin: false };
}
