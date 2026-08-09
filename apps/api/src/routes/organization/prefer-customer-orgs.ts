interface OrgWithDomain {
    domain: string | null;
}

/**
 * Drops the internal organization from a set of candidates that own the same application slug, as
 * long as a customer organization also owns it.
 *
 * The internal org dogfoods customer applications, so a slug like `checkout` frequently exists both
 * there and in the customer's own org. Somebody following a shared link virtually always wants the
 * customer's copy - landing in our dogfood clone looks like the link was wrong, and any action taken
 * there is taken against the wrong data.
 *
 * Falls back to the full set when the internal org is the *only* owner, so an internal-only app is
 * still reachable.
 *
 * Shared by both slug lookups (`admin.findOrgByAppSlug` and `organization.appSlugOwners`) because
 * having the rule in one of them and not the other is exactly how it got lost: the membership-scoped
 * lookup shipped without it, which put the dogfood org back in front of staff.
 */
export function preferCustomerOrgs<T extends { organization: OrgWithDomain }>(
    owners: T[],
    internalDomain: string,
): T[] {
    const customerOwned = owners.filter((owner) => owner.organization.domain !== internalDomain);
    return customerOwned.length > 0 ? customerOwned : owners;
}
