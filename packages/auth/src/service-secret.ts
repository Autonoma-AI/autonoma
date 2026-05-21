import { constantTimeEqual } from "./api-key";

/**
 * Verifies an `Authorization: Bearer <secret>` header against a service
 * shared secret (typically loaded from an env var on both ends). Constant-
 * time compare to avoid timing oracle attacks against the secret value.
 *
 * Returns `true` if the bearer token matches the expected secret. Returns
 * `false` for any other case - missing header, malformed scheme, mismatched
 * secret - so callers can fall through to other auth schemes (API key,
 * session cookie) without needing to distinguish failure reasons.
 *
 * If the expected secret is unset (`expectedSecret == null` or empty), this
 * always returns `false`. That prevents accidental "no env var, no auth"
 * scenarios in production.
 */
export function verifyServiceSecret(
    authorizationHeader: string | undefined,
    expectedSecret: string | undefined,
): boolean {
    if (expectedSecret == null || expectedSecret.length === 0) return false;

    const rawToken = authorizationHeader?.replace(/^Bearer\s+/i, "");
    if (rawToken == null || rawToken.length === 0) return false;

    return constantTimeEqual(rawToken, expectedSecret);
}
