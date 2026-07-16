import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { GitHubInstallationService } from "../github/github-installation.service";

/** Cap the discovery list; an internal user can belong to many orgs. */
const MAX_REPOS = 100;

export interface AccessibleRepo {
    repoFullName: string;
    organization: string;
}

/**
 * List the repos an MCP-authenticated user can debug: every repo in an organization the user is a member of
 * that is linked to an Autonoma application (via the org's GitHub App installation, NOT PreviewKit - so
 * diffs-only apps that never deploy a preview still show up). This is the discovery entry point - when the
 * agent can't infer the repo from the git remote, it calls this so the user can pick one. Bounded to
 * {@link MAX_REPOS}; `truncated` signals there were more.
 */
export async function listAccessibleRepos(
    github: GitHubInstallationService,
    userId: string,
): Promise<{ repos: AccessibleRepo[]; truncated: boolean }> {
    const logger = rootLogger.child({ name: "listAccessibleRepos" });

    const memberships = await db.member.findMany({ where: { userId }, select: { organizationId: true } });
    const orgIds = memberships.map((membership) => membership.organizationId);
    if (orgIds.length === 0) return { repos: [], truncated: false };

    const orgs = await db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));

    // Each org's installation repo list is an independent GitHub App call, so fan them out.
    const listedPerOrg = await Promise.all(
        orgIds.map(async (organizationId) => {
            try {
                return { organizationId, repos: await github.listRepositories(organizationId) };
            } catch (err) {
                logger.warn("Failed to list installation repos for discovery; skipping org", {
                    organizationId,
                    extra: { err },
                });
                return { organizationId, repos: [] };
            }
        }),
    );

    const all: AccessibleRepo[] = [];
    for (const { organizationId, repos: listed } of listedPerOrg) {
        for (const repo of listed) {
            // Only repos linked to an Autonoma application are debuggable; a raw installation repo is not.
            if (repo.applicationId == null) continue;
            all.push({
                repoFullName: repo.fullName,
                organization: orgNameById.get(organizationId) ?? organizationId,
            });
        }
    }
    all.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));

    const truncated = all.length > MAX_REPOS;
    const repos = all.slice(0, MAX_REPOS);

    logger.info("Listed accessible repos", { userId, extra: { count: repos.length, truncated } });
    return { repos, truncated };
}
