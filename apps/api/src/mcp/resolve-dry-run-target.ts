import { BadRequestError } from "@autonoma/errors";
import type { Services } from "../routes/build-services";

/**
 * Turn a dry-run target ID into the SDK URL to provision against.
 *
 * The agent names a target; the URL is looked up here, from the server's own list. That is the
 * whole point of taking an id rather than a URL - a tool that accepted a URL would let a caller
 * aim a signed provisioning request at any host it liked.
 *
 * Returns undefined when no target was named, which means "use the app's stored SDK endpoint".
 */
export async function resolveDryRunTargetUrl(
    services: Services,
    applicationId: string,
    organizationId: string,
    targetId: string | undefined,
): Promise<string | undefined> {
    if (targetId == null) return undefined;

    const { targets } = await services.onboarding.listSdkDryRunTargets(applicationId, organizationId);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (target == null) {
        const known = targets.map((candidate) => candidate.id).join(", ");
        throw new BadRequestError(
            `Unknown dry-run target "${targetId}". Available: ${known.length > 0 ? known : "none"}.`,
        );
    }
    if (target.sdkUrl == null) {
        throw new BadRequestError(
            `Dry-run target "${targetId}" has no deployed preview to run against (${target.availability}). ` +
                "Deploy it first, or pick a target that is ready.",
        );
    }

    return target.sdkUrl;
}
