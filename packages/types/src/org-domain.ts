/**
 * An organization's `domain` column encodes how people reach the org without being invited:
 *
 * - `"acme.com"` - a bare email domain. Anyone signing up with an `@acme.com` address is
 *   auto-joined, so the org grows on its own and never needs invitations.
 * - `"tom@gmail.com"` - a full email address. The org belongs to exactly one person and
 *   nobody is ever auto-joined into it.
 * - `null` - no domain at all (Vercel Marketplace installs, the demo org, seeds). Same as
 *   above: nobody is auto-joined.
 *
 * The `@` is what separates the two non-null cases, so it is the whole test.
 */
export function orgHasAutoJoinDomain(domain: string | undefined): boolean {
    return domain != null && domain.includes("@") === false;
}

/**
 * Whether this address would be auto-joined into an organization keyed on `orgDomain` - the only case
 * where sending an invitation achieves nothing, because signing up already puts them there.
 *
 * Note what this is NOT: "does the organization have an auto-join domain". A company organization
 * still needs to invite people from outside it - a contractor on gmail, someone at a partner company,
 * a founder's own personal address. Refusing every invitation just because the organization happens to
 * be domain-keyed locks those people out, which is exactly what it did.
 */
export function emailAutoJoinsOrg(email: string, orgDomain: string | undefined): boolean {
    if (!orgHasAutoJoinDomain(orgDomain)) return false;
    const inviteeDomain = email.split("@")[1]?.trim().toLowerCase();
    if (inviteeDomain == null || inviteeDomain === "") return false;
    return inviteeDomain === orgDomain?.trim().toLowerCase();
}
