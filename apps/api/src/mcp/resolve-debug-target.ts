import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { findApplicationRepo } from "../github/application-repo";
import type { McpPrincipal } from "./mcp-principal";
import { isRepositoryTarget, type McpTargetDeps, type McpTargetInput, resolveMcpTarget } from "./resolve-mcp-target";
import { resolveRepoContext } from "./resolve-repo-context";

/**
 * An application named either way, plus the two keys the previewkit surface is actually stored
 * under.
 *
 * The debug tools reach services keyed by "owner/repo" (environments, logs, secrets) and by the
 * numeric repository id (the GitHub calls behind `start_analysis`), so resolving to an
 * application id alone is not enough for them - unlike the read/recipe/config tools, which take
 * {@link McpTarget} and stop there.
 */
export interface DebugTarget {
    organizationId: string;
    applicationId: string;
    /** "owner/repo": the key previewkit environments, logs and secrets are stored under. */
    repoFullName: string;
    /** The linked GitHub repository's numeric id. Absent when the caller named the app by id and no repo is linked. */
    githubRepositoryId?: number;
}

/**
 * Resolve either form of application identity to the previewkit keys the debug tools need.
 *
 * Authorization is unchanged in both branches - each defers to the resolver that already enforces
 * it, so naming an app by id reaches exactly what naming its repo would.
 */
export async function resolveDebugTarget(
    deps: McpTargetDeps,
    principal: McpPrincipal,
    input: McpTargetInput,
): Promise<DebugTarget> {
    if (isRepositoryTarget(input)) {
        const context = await resolveRepoContext(deps, principal, input.repoFullName);
        return {
            organizationId: context.organizationId,
            applicationId: context.applicationId,
            repoFullName: input.repoFullName,
            githubRepositoryId: context.githubRepositoryId,
        };
    }

    const logger = rootLogger.child({ name: "resolveDebugTarget" });
    const target = await resolveMcpTarget(deps, principal, input);
    const repo = await findApplicationRepo(deps, target.organizationId, target.applicationId);

    // The application resolved, so this is not an authorization answer and must not read like one:
    // the caller holds a real app that simply has no repository these tools can address.
    if (repo == null) {
        logger.warn("Application has no repository the previewkit tools can address", {
            organizationId: target.organizationId,
            application: { applicationId: target.applicationId },
        });
        throw new NotFoundError(
            `Application ${target.applicationId} has no GitHub repository linked, so its preview environment ` +
                `cannot be addressed by these tools. Link the repository first (link_repository during ` +
                `onboarding), or name the app by repoFullName ('owner/repo') if you know it.`,
        );
    }

    logger.info("Resolved a debug target from an application id", {
        organizationId: target.organizationId,
        application: { applicationId: target.applicationId },
        extra: { repoFullName: repo.fullName },
    });
    return {
        organizationId: target.organizationId,
        applicationId: target.applicationId,
        repoFullName: repo.fullName,
        githubRepositoryId: repo.githubRepositoryId,
    };
}
