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
