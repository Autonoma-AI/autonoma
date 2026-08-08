import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";
import type { Auth } from "../../auth";

/**
 * Shape of the session payload better-auth persists in secondary storage (Redis).
 * Only the fields we read or must rewrite are declared; `.passthrough()` keeps every
 * other key (the full user + session objects) intact so re-serializing never drops
 * data. Validated here because the value crosses a runtime boundary (JSON out of Redis).
 */
const StoredSessionSchema = z
    .object({
        session: z
            .object({
                expiresAt: z.union([z.string(), z.number()]),
                activeOrganizationId: z.string().nullish(),
            })
            .passthrough(),
    })
    .passthrough();

/**
 * Rewrites the active organization on a session directly in better-auth's secondary
 * storage (Redis) - the source of truth read on every request - so this is what
 * actually switches which org a session acts as. Deliberately touches no `member`
 * row: the caller decides whether membership is required (admin switch upserts one;
 * the read-only demo entry does not). No-op if the session is no longer in storage.
 */
export async function setSessionActiveOrg(
    auth: Auth,
    sessionToken: string,
    orgId: string,
    /**
     * When given, only rewrite the session if it is currently acting as this organization. Used when
     * a membership is lost: sessions aimed at the lost organization have to move, but a session
     * working in an unrelated organization the user still belongs to must be left where it is.
     */
    onlyIfActiveOrgIs?: string,
): Promise<void> {
    const logger = rootLogger.child({ name: "setSessionActiveOrg" });
    logger.info("Setting session active org", { organizationId: orgId });

    const ctx = await auth.$context;
    const raw = await ctx.secondaryStorage?.get(sessionToken);
    if (typeof raw !== "string") {
        logger.warn("Session not found in secondary storage; cannot set active org", { organizationId: orgId });
        return;
    }

    const parsed = StoredSessionSchema.parse(JSON.parse(raw));

    if (onlyIfActiveOrgIs != null && parsed.session.activeOrganizationId !== onlyIfActiveOrgIs) {
        logger.info("Session is acting as another organization; left unchanged", { organizationId: orgId });
        return;
    }

    parsed.session.activeOrganizationId = orgId;

    const ttlSeconds = Math.floor((new Date(parsed.session.expiresAt).getTime() - Date.now()) / 1000);
    await ctx.secondaryStorage?.set(sessionToken, JSON.stringify(parsed), ttlSeconds);

    logger.info("Session active org set", { organizationId: orgId });
}
