import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import type { McpPrincipal } from "./mcp-principal";
import { type RepoContextDeps, resolveRepoContext } from "./resolve-repo-context";

/**
 * How a tool names the application it acts on. The two MCP servers grew separate answers to
 * the same question, which is why seven tool names exist on both with signatures that differ
 * only in this field.
 *
 * Both remain valid, because each is the only thing the caller has at the time. During
 * onboarding there is no repository linked yet and the app id came from a pairing code; after
 * onboarding an agent is sitting in a checkout and knows its remote, not an opaque id.
 */
export interface ApplicationTarget {
    /** The application's own id - what a paired onboarding agent is handed. */
    applicationId: string;
}

export interface RepositoryTarget {
    /** "owner/repo" - what an agent sitting in a checkout can read off the git remote. */
    repoFullName: string;
}

export type McpTargetInput = ApplicationTarget | RepositoryTarget;

/** Narrows to the repository form, so the branch reads as intent rather than key-probing. */
export function isRepositoryTarget(input: McpTargetInput): input is RepositoryTarget {
    return "repoFullName" in input;
}

/** The application a tool call acts on, and the organization that owns it. */
export interface McpTarget {
    organizationId: string;
    applicationId: string;
}

export interface McpTargetDeps extends RepoContextDeps {
    db: PrismaClient;
}

/**
 * Resolve either form of application identity to the same target.
 *
 * Authorization is the principal's organizations in both branches, so neither input can reach
 * an application the credential could not otherwise. The two paths differ only in how they
 * find the application, never in what they permit.
 *
 * Throws `NotFoundError` for an application outside the principal's reach, with the same
 * message as one that does not exist - the two must stay indistinguishable so a credential
 * cannot probe for applications it cannot see.
 */
export async function resolveMcpTarget(
    deps: McpTargetDeps,
    principal: McpPrincipal,
    input: McpTargetInput,
): Promise<McpTarget> {
    const logger = rootLogger.child({ name: "resolveMcpTarget" });

    if (isRepositoryTarget(input)) {
        const context = await resolveRepoContext(deps, principal, input.repoFullName);
        return { organizationId: context.organizationId, applicationId: context.applicationId };
    }

    const application = await deps.db.application.findFirst({
        where: {
            id: input.applicationId,
            disabled: false,
            organizationId: { in: principal.organizationIds },
        },
        select: { id: true, organizationId: true },
    });

    if (application == null) {
        logger.warn("No enabled application in the caller's organizations", {
            userId: principal.userId,
            extra: { applicationId: input.applicationId },
        });
        throw new NotFoundError(`No application found for ${input.applicationId}`);
    }

    return { organizationId: application.organizationId, applicationId: application.id };
}
