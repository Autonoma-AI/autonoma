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
