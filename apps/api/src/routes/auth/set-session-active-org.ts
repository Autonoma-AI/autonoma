import { logger as rootLogger } from "@autonoma/logger";
import type { Auth } from "../../auth";

/**
 * Switches which organization a session acts as.
 *
 * Delegates to better-auth's own `internalAdapter.updateSession`, which is the only thing that
 * updates every place a session lives. Doing it by hand got this wrong twice over:
 *
 * - A session is stored twice. The `session` table is the durable copy (`storeSessionInDatabase:
 *   true` in `auth.ts`) and Redis is the cache `getSession` reads first. The old implementation wrote
 *   Redis only, and the shared Redis runs `maxmemory 400mb` with `allkeys-lru` - so an evicted
 *   session left the user signed in (Postgres backs them) while every write silently found no key and
 *   did nothing. `updateSession` writes Redis when it holds the session and runs the durable write
 *   regardless, because it passes `executeMainFn: options.session.storeSessionInDatabase`.
 * - Redis also holds an `active-sessions-<userId>` index, which `updateSession` keeps in step and a
 *   hand-rolled `secondaryStorage.set` does not.
 *
 * Deliberately touches no `member` row: the caller decides whether membership is required (the admin
 * switch upserts one; the read-only demo entry does not).
 */
export async function setSessionActiveOrg(
    auth: Auth,
    sessionToken: string,
    orgId: string,
    /**
     * When given, only move the session if it is currently acting as this organization. Used when a
     * membership is lost: sessions aimed at the lost organization have to move, but a session
     * working in an unrelated organization the user still belongs to must be left where it is.
     */
    onlyIfActiveOrgIs?: string,
): Promise<void> {
    const logger = rootLogger.child({ name: "setSessionActiveOrg" });
    logger.info("Setting session active org", { organizationId: orgId });

    const ctx = await auth.$context;

    if (onlyIfActiveOrgIs != null) {
        // `findSession` resolves through Redis and falls back to the session table, so this sees the
        // session even when the cache has evicted it.
        const current = await ctx.internalAdapter.findSession(sessionToken);
        if (current == null) {
            logger.warn("Session no longer exists; nothing to move", { organizationId: orgId });
            return;
        }
        if (current.session.activeOrganizationId !== onlyIfActiveOrgIs) {
            logger.info("Session is acting as another organization; left unchanged", { organizationId: orgId });
            return;
        }
    }

    await ctx.internalAdapter.updateSession(sessionToken, { activeOrganizationId: orgId });

    logger.info("Session active org set", { organizationId: orgId });
}
