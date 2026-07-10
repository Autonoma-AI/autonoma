import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

/** Cap the discovery list; an internal user can belong to many orgs. */
const MAX_REPOS = 100;

export interface AccessibleRepo {
    repoFullName: string;
    organization: string;
}

/**
 * List the repos an MCP-authenticated user can debug: every repo with an Autonoma
 * preview environment in an organization the user is a member of. This is the
 * discovery entry point - when the agent can't infer the repo from the working
 * directory's git remote, it calls this so the user can pick one. Bounded to
 * {@link MAX_REPOS}; `truncated` signals there were more.
 */
export async function listAccessibleRepos(
    db: PrismaClient,
    userId: string,
): Promise<{ repos: AccessibleRepo[]; truncated: boolean }> {
    const logger = rootLogger.child({ name: "listAccessibleRepos" });

    const memberships = await db.member.findMany({ where: { userId }, select: { organizationId: true } });
    const orgIds = memberships.map((membership) => membership.organizationId);
    if (orgIds.length === 0) return { repos: [], truncated: false };

    // One row per repo (repos map to a single owning org), newest-name-last for a
    // stable list. Fetch one extra to detect truncation without a second count.
    const environments = await db.previewkitEnvironment.findMany({
        where: { organizationId: { in: orgIds }, githubRepositoryId: { not: null } },
        select: { repoFullName: true, organizationId: true },
        distinct: ["repoFullName"],
        orderBy: { repoFullName: "asc" },
        take: MAX_REPOS + 1,
    });
    const truncated = environments.length > MAX_REPOS;
    const page = environments.slice(0, MAX_REPOS);

    const orgs = await db.organization.findMany({
        where: { id: { in: [...new Set(page.map((environment) => environment.organizationId))] } },
        select: { id: true, name: true },
    });
    const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));

    const repos = page.map((environment) => ({
        repoFullName: environment.repoFullName,
        organization: orgNameById.get(environment.organizationId) ?? environment.organizationId,
    }));

    logger.info("Listed accessible repos", { userId, extra: { count: repos.length, truncated } });
    return { repos, truncated };
}
