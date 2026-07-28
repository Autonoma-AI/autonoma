import { BadRequestError } from "@autonoma/errors";
import type { Services } from "../routes/build-services";
import type { SdkDryRunTarget } from "../routes/onboarding/sdk-dry-run-targets";

/**
 * Look up a dry-run target by the ID an agent named, from the server's own list.
 *
 * Taking an id rather than a URL is the whole point: a tool that accepted a URL would let a
 * caller aim a signed provisioning request - or a log read - at any host it liked.
 *
 * Throws when the id is unknown, listing the ids that do exist so the agent can correct itself
 * in one turn instead of guessing.
 */
export async function resolveDryRunTarget(
    services: Services,
    applicationId: string,
    organizationId: string,
    targetId: string,
): Promise<SdkDryRunTarget> {
    const { targets } = await services.onboarding.listSdkDryRunTargets(applicationId, organizationId);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (target == null) {
        const known = targets.map((candidate) => candidate.id).join(", ");
        throw new BadRequestError(
            `Unknown dry-run target "${targetId}". Available: ${known.length > 0 ? known : "none"}.`,
        );
    }
    return target;
}

/**
 * Turn a dry-run target ID into the SDK URL to provision against.
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

    const target = await resolveDryRunTarget(services, applicationId, organizationId, targetId);
    if (target.sdkUrl == null) {
        throw new BadRequestError(
            `Dry-run target "${targetId}" has no deployed preview to run against (${target.availability}). ` +
                "Deploy it first, or pick a target that is ready.",
        );
    }

    return target.sdkUrl;
}
