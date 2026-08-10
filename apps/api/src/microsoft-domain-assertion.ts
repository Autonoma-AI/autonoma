import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";
import type { SignupDomainAssertion } from "./signup-domain-assertion";

/**
 * The tenant every personal Microsoft account belongs to. A well-known constant, not per-app: any
 * token carrying it is an MSA (outlook.com, hotmail.com, or a custom domain attached to a personal
 * account) rather than a work or school account.
 */
const CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * The claims this decision reads. Validated rather than trusted: it arrives from a decoded id token
 * handed over by the better-auth provider, which is outside our type system, and a missing claim must
 * mean "assert nothing" rather than throw inside a sign-in.
 */
const MicrosoftIdTokenClaimsSchema = z
    .object({
        tid: z.string().optional(),
        /** The UPN. Entra requires it to sit on a domain the tenant has verified. */
        preferred_username: z.string().optional(),
        email: z.string().optional(),
        /**
         * Present only when somebody else's identity provider authenticated this user - which is
         * exactly the B2B guest case, where tenant membership says nothing about the email's domain.
         */
        idp: z.string().optional(),
    })
    .loose();

function domainOf(address: string | undefined): string | undefined {
    const domain = address?.split("@")[1]?.trim().toLowerCase();
    return domain != null && domain !== "" ? domain : undefined;
}

/**
 * What Microsoft's id token settles about the signing-in account's email domain, or undefined to fall
 * back to the consumer-provider list.
 *
 * Three cases, and the conservative ones are deliberate - a wrong "company" here auto-joins a stranger
 * into somebody's organization, while a wrong "personal" only gives them their own:
 *
 * - **`tid` is the consumer tenant** -> a personal account, whatever its domain looks like. This is the
 *   case no list can catch, because a personal Microsoft account can wear a custom domain. Reachable
 *   only where `MICROSOFT_TENANT_ID` is `common`; the default `organizations` rejects MSAs outright.
 * - **A native member of a real tenant** (`tid` set, no `idp`) whose UPN and email agree -> a company
 *   domain. Entra only issues a UPN on a domain the tenant has verified, so this is the same
 *   ownership proof Google's `hd` gives.
 * - **Anything else** -> no assertion. A B2B guest carries the host tenant's `tid` while their address
 *   belongs elsewhere, so reading tenant membership as domain ownership would let a guest at
 *   `bigcorp.com` turn their own consumer domain into an auto-join key.
 */
export function microsoftDomainAssertion(profile: unknown): SignupDomainAssertion | undefined {
    const logger = rootLogger.child({ name: "microsoftDomainAssertion" });
    const parsed = MicrosoftIdTokenClaimsSchema.safeParse(profile);
    if (!parsed.success) {
        logger.warn("Microsoft id token claims were not the expected shape; asserting nothing", {
            extra: { issues: parsed.error.issues.length },
        });
        return undefined;
    }

    const claims = parsed.data;
    if (claims.tid == null) return undefined;

    if (claims.tid === CONSUMER_TENANT_ID) {
        logger.info("Microsoft asserts a personal account");
        return { provider: "microsoft" };
    }

    if (claims.idp != null) {
        logger.info("Microsoft account is a federated guest; asserting nothing");
        return undefined;
    }

    const upnDomain = domainOf(claims.preferred_username);
    if (upnDomain == null) return undefined;

    // When the mail attribute sits on a different domain than the verified UPN, the tenant has only
    // vouched for the UPN's - so say nothing rather than assert ownership of the other one.
    const emailDomain = domainOf(claims.email);
    if (emailDomain != null && emailDomain !== upnDomain) {
        logger.info("Microsoft email and UPN domains disagree; asserting nothing");
        return undefined;
    }

    logger.info("Microsoft asserts a tenant-verified domain");
    return { provider: "microsoft", managedDomain: upnDomain };
}
