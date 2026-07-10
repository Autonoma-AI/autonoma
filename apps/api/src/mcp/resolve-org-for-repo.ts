import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";

/**
 * Resolve the organization an MCP tool call acts in FROM the resource it names.
 * The OAuth access token carries only `userId` (no org) and a user can belong to
 * many orgs, so no single org can be picked up front. Instead every previewkit
 * tool is keyed by `repoFullName`, which maps to exactly one owning org (through
 * any preview environment for that repo). We resolve that org and verify the
 * authenticated user is a member - so a token can only ever read orgs the user
 * belongs to, and the org is unambiguous no matter how many orgs the user is in.
 *
 * Throws NotFoundError (never an authorization-specific error) when the repo has
 * no preview environment OR the user is not a member of the owning org: the two
 * are indistinguishable to the caller, so a token can't probe which repos exist
 * in orgs the user can't see.
 */
export async function resolveOrgForRepo(db: PrismaClient, userId: string, repoFullName: string): Promise<string> {
    const logger = rootLogger.child({ name: "resolveOrgForRepo" });

    const environments = await db.previewkitEnvironment.findMany({
        where: { repoFullName, githubRepositoryId: { not: null } },
        select: { organizationId: true },
        distinct: ["organizationId"],
    });
    const ownerOrgIds = environments.map((environment) => environment.organizationId);
    if (ownerOrgIds.length === 0) {
        throw new NotFoundError(`No preview environment found for ${repoFullName}`);
    }

    const memberships = await db.member.findMany({
        where: { userId, organizationId: { in: ownerOrgIds } },
        select: { organizationId: true },
    });
    if (memberships.length === 0) {
        logger.warn("MCP user is not a member of the org that owns the repo", { userId, extra: { repoFullName } });
        // Same message as "not found" so a token cannot probe repos in other orgs.
        throw new NotFoundError(`No preview environment found for ${repoFullName}`);
    }
    if (memberships.length > 1) {
        // A repo linked to two of the user's own orgs (e.g. internal dogfooding).
        // Rare; surface it rather than silently returning the wrong org's data.
        throw new NotFoundError(
            `${repoFullName} is linked to more than one of your organizations; cannot disambiguate`,
        );
    }

    const organizationId = memberships[0]?.organizationId;
    if (organizationId == null) throw new NotFoundError(`No preview environment found for ${repoFullName}`);

    logger.info("Resolved org for repo", { organizationId, extra: { repoFullName } });
    return organizationId;
}
