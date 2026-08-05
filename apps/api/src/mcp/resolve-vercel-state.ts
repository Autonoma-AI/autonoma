import { logger as rootLogger } from "@autonoma/logger";
import type { Services } from "../routes/build-services";
import type { VercelState } from "./vercel-onboarding-guidance";

/**
 * How far along this app's Vercel connection is, used to pick which
 * bring-your-own-deploys playbook to hand over. DB-only (no Vercel API call),
 * so it is cheap enough to resolve on every pair / path decision.
 *
 * Best-effort: an app whose Vercel state cannot be read falls back to "not on
 * Vercel". That degrades to the webhook playbook, which is wrong but merely
 * more work - whereas failing here would break pairing, the one call that has
 * to succeed.
 */
export async function resolveVercelState(
    services: Services,
    applicationId: string,
    organizationId: string,
): Promise<VercelState> {
    const logger = rootLogger.child({ name: "resolveVercelState" });
    try {
        const projects = await services.onboarding.listAvailableVercelProjects(applicationId, organizationId);
        return { installed: projects.connected, linked: projects.linkedProject != null };
    } catch (err) {
        logger.warn("Could not resolve Vercel state; assuming this app is not on Vercel", { applicationId, err });
        return { installed: false, linked: false };
    }
}
