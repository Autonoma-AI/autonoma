import { logger as rootLogger } from "@autonoma/logger";
import type Redis from "ioredis";

// The hint is written while the OAuth callback is being handled and read a moment later, in the
// database hook that picks the organization. A minute is far longer than that gap and short enough
// that a hint can never be mistaken for a later sign-in's.
const ASSERTION_TTL_SECONDS = 60;
const KEY_PREFIX = "signup-domain-assertion";

/**
 * What an identity provider told us about the email domain of the account signing in.
 *
 * `managed` is a *positive assertion of domain ownership*, not a guess: the provider is stating that
 * this domain is administered as an organization on its platform. It is the only thing that makes a
 * domain an auto-join key, so its absence costs colleagues an invitation rather than costing strangers
 * a shared organization.
 */
export interface SignupDomainAssertion {
    /** The provider that made the assertion. Only providers that actually assert are recorded. */
    provider: "google" | "microsoft";
    /** The managed domain the provider named, absent when it said the account has none. */
    managedDomain?: string;
}

const ASSERTING_PROVIDERS: ReadonlySet<string> = new Set(["google", "microsoft"]);

function isAssertingProvider(value: unknown): value is SignupDomainAssertion["provider"] {
    return typeof value === "string" && ASSERTING_PROVIDERS.has(value);
}

function assertionKey(email: string): string {
    return `${KEY_PREFIX}:${email.trim().toLowerCase()}`;
}

/**
 * Records what the provider asserted about this address, for the organization decision that follows.
 *
 * Goes through Redis rather than a parameter because the two points are in different calls: the
 * assertion arrives in the provider's `getUserInfo`, and the organization is chosen later in
 * better-auth's `user.create` database hook, which is handed the user row and nothing else. The
 * Vercel sign-in path already passes a hint between the same two points this way
 * (`vercelPreferredOrgKey`).
 *
 * Best-effort by design: a failure here loses the assertion, and a lost assertion means this signup
 * gets its own organization - the same outcome as every provider that asserts nothing. Costing someone
 * an invitation is always cheaper than failing their sign-in.
 */
export async function rememberSignupDomainAssertion(
    redis: Redis,
    email: string,
    assertion: SignupDomainAssertion,
): Promise<void> {
    const logger = rootLogger.child({ name: "rememberSignupDomainAssertion" });
    try {
        await redis.set(assertionKey(email), JSON.stringify(assertion), "EX", ASSERTION_TTL_SECONDS);
        logger.info("Recorded signup domain assertion", {
            extra: { provider: assertion.provider, hasManagedDomain: assertion.managedDomain != null },
        });
    } catch (err) {
        logger.warn("Could not record the signup domain assertion; this signup gets its own organization", {
            extra: { provider: assertion.provider },
            err,
        });
    }
}

/**
 * Reads and clears the assertion for this address, or undefined when no provider made one.
 *
 * Cleared on read so a stale hint cannot influence a later sign-in for the same address - a second
 * sign-in must be decided by what its own provider says.
 */
export async function takeSignupDomainAssertion(
    redis: Redis,
    email: string,
): Promise<SignupDomainAssertion | undefined> {
    const logger = rootLogger.child({ name: "takeSignupDomainAssertion" });
    const key = assertionKey(email);
    try {
        const raw = await redis.getdel(key);
        if (raw == null) return undefined;
        return parseAssertion(raw);
    } catch (err) {
        logger.warn("Could not read the signup domain assertion; this signup gets its own organization", { err });
        return undefined;
    }
}

function parseAssertion(raw: string): SignupDomainAssertion | undefined {
    const logger = rootLogger.child({ name: "parseAssertion" });
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed == null) return undefined;
        const provider = Reflect.get(parsed, "provider");
        if (!isAssertingProvider(provider)) return undefined;
        const managedDomain = Reflect.get(parsed, "managedDomain");
        if (typeof managedDomain === "string" && managedDomain.trim() !== "") {
            return { provider, managedDomain };
        }
        return { provider };
    } catch (err) {
        logger.warn("Signup domain assertion was not readable JSON; ignoring it", { err });
        return undefined;
    }
}

/**
 * Whether the provider's assertion settles that `domain` belongs to one organization.
 *
 * Returns undefined when no provider asserted anything, which the caller treats the same as a denial:
 * only a positive assertion keys an organization on a bare domain.
 *
 * For Google this is a complete answer rather than a hint, and that is the point: signing in with
 * Google as `someone@acme.com` is only possible when `acme.com` is a Workspace domain, and Workspace
 * always sends `hd`. So `hd` present and matching means a company domain, and `hd` absent means a
 * personal account - the provider settles it, and nothing has to be guessed from the domain itself.
 *
 * Microsoft answers the same question from the tenant its id token names, but only in the cases where
 * tenant membership actually proves who owns the address - see `microsoftDomainAssertion`. Where it
 * does not, no assertion is recorded and the signup gets its own organization.
 */
export function assertedCompanyDomain(
    assertion: SignupDomainAssertion | undefined,
    domain: string,
): boolean | undefined {
    if (assertion == null) return undefined;
    if (assertion.managedDomain == null) return false;
    return assertion.managedDomain.trim().toLowerCase() === domain.trim().toLowerCase();
}
