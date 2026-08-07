import { logger as rootLogger } from "@autonoma/logger";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

/** How long an install link stays valid. Exported so a caller can tell an agent when to stop waiting. */
export const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Audience for the install-state token. `jose` verifies it as part of the signature check, so a
 * token minted for some other purpose against the same secret cannot be replayed as install state.
 */
const INSTALL_STATE_AUDIENCE = "autonoma:github-install-state";

const HMAC_ALGORITHM = "HS256";

const InstallStateSchema = z.object({
    organizationId: z.string().min(1),
    returnPath: z.string().optional(),
});

export type InstallStatePayload = z.infer<typeof InstallStateSchema>;

/**
 * Signing key for the install state.
 *
 * `BETTER_AUTH_SECRET` is read here rather than through `env.ts` because better-auth owns the
 * variable and validates it at startup; this module only borrows it.
 */
function getKey(): Uint8Array {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret == null) throw new Error("BETTER_AUTH_SECRET is not set");
    return new TextEncoder().encode(secret);
}

/**
 * Opaque, tamper-evident proof that WE started an install for a specific organization, carried
 * through GitHub and handed back on the callback.
 *
 * A signed JWT via `jose` rather than hand-rolled `base64url(payload).hmac`: the previous version
 * open-coded the signature comparison, the expiry check and the purpose tag, and `jose` does all
 * three - including pinning the algorithm on verify, which is the footgun that makes hand-rolled
 * token code worth avoiding.
 *
 * NOT encrypted - the payload is readable by anyone holding the link, which is fine because it
 * only names an organization the holder is already installing for. It is also NOT authorization to
 * bind any particular installation: state cannot name one, because it is minted before the
 * installation exists. See `handleInstallation` for what actually gates the bind.
 */
export async function createInstallState(organizationId: string, returnPath?: string): Promise<string> {
    return await new SignJWT({ organizationId, returnPath })
        .setProtectedHeader({ alg: HMAC_ALGORITHM })
        .setAudience(INSTALL_STATE_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(new Date(Date.now() + INSTALL_STATE_TTL_MS))
        .sign(getKey());
}

/**
 * Returns the claims when `state` verifies, undefined for every failure - tampered, expired, wrong
 * audience, wrong algorithm, or malformed. Callers must not branch on which.
 */
export async function verifyInstallState(state: string): Promise<InstallStatePayload | undefined> {
    const logger = rootLogger.child({ name: "verifyInstallState" });

    try {
        const { payload } = await jwtVerify(state, getKey(), {
            algorithms: [HMAC_ALGORITHM],
            audience: INSTALL_STATE_AUDIENCE,
        });
        return InstallStateSchema.parse(payload);
    } catch (err) {
        // Expected for an expired link, and the shape of every rejection an attacker can produce -
        // so debug, not warn. The callback logs the consequence at its own level.
        logger.debug("Install state did not verify", { extra: { err } });
        return undefined;
    }
}
