import { z } from "zod";

const PEM_BEGIN_MARKER = "-----BEGIN";

/**
 * Schema for a GitHub App private key supplied as base64-encoded PEM.
 *
 * The secret travels as base64 to avoid newline/escape mangling through env-var
 * pipelines (Kubernetes Secrets, jq, shell). The transform decodes it once at
 * boot so downstream consumers see a normal PEM string.
 *
 * Fails fast if the value is not base64 or does not decode to something
 * containing the PEM `-----BEGIN` marker, instead of letting the bad value
 * propagate to `createPrivateKey` at first use.
 */
export const base64PrivateKey = z
    .string()
    .min(1)
    .transform((value, ctx) => {
        const trimmed = value.trim();
        const decoded = Buffer.from(trimmed, "base64").toString("utf8");

        if (!decoded.includes(PEM_BEGIN_MARKER)) {
            ctx.addIssue({
                code: "custom",
                message: "Private key must be a base64-encoded PEM (got something that does not decode to a PEM).",
            });
            return z.NEVER;
        }

        return decoded;
    });

/**
 * Return a GitHub App private key as a PEM: pass an already-decoded PEM through unchanged, otherwise
 * decode it from base64. For consumers that may receive either form - e.g. one whose env skipped the
 * {@link base64PrivateKey} transform (under `TESTING`) and still holds the raw base64.
 */
export function ensurePem(value: string): string {
    return value.includes(PEM_BEGIN_MARKER) ? value : Buffer.from(value.trim(), "base64").toString("utf8");
}
