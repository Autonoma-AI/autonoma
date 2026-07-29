import { createHash } from "node:crypto";

/** How many leading hex chars of the SHA-256 digest form the fingerprint (48 bits - ample for equality checks). */
const FINGERPRINT_HEX_LENGTH = 12;

/**
 * A non-reversible fingerprint of a secret value: the first {@link FINGERPRINT_HEX_LENGTH}
 * hex chars of SHA-256(value). It lets a caller check whether a value MATCHES a
 * candidate they already hold - recompute `sha256(value).hex.slice(0, 12)` and
 * compare - without ever exposing the value. Unsalted on purpose, so the check is
 * reproducible client-side; only ever returned to an authenticated org member who
 * already has write access to the secret.
 */
export function secretFingerprint(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}
