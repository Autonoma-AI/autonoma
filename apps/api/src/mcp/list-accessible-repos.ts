import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { GitHubInstallationService } from "../github/github-installation.service";
import type { McpPrincipal } from "./mcp-principal";
import { describeError } from "./tool-result";

/** Cap the discovery list; an internal user can belong to many orgs. */
const MAX_REPOS = 100;

export interface AccessibleRepo {
    repoFullName: string;
    organization: string;
}

/** An organization whose repositories could not be read, so the listing is missing whatever it holds. */
export interface UnreadableOrganization {
    organization: string;
    reason: string;
}

export interface AccessibleRepos {
    repos: AccessibleRepo[];
    truncated: boolean;
    /** Organizations left out of `repos` because Autonoma could not read them - the list is INCOMPLETE when non-empty. */
    unreadable: UnreadableOrganization[];
}

/**
 * List the repos an MCP caller can debug: every repo in one of the principal's organizations that is linked
 * to an Autonoma application (via the org's GitHub App installation, NOT PreviewKit - so diffs-only apps that
 * never deploy a preview still show up). This is the discovery entry point - when the agent can't infer the
 * repo from the git remote, it calls this so the user can pick one. Bounded to {@link MAX_REPOS}; `truncated`
 * signals there were more.
 *
 * An org whose installation cannot be read is reported in `unreadable` rather than dropped. Silently omitting
 * it produced the worst possible answer: a shorter list that looks complete, so an agent concludes a repo it
 * can debug through every other tool simply is not there.
 *
 * Discovery reads the same principal as resolution, so a credential can never advertise a repo it would then
 * be refused when it tried to act on it.
 */
export async function listAccessibleRepos(
    github: GitHubInstallationService,
    principal: McpPrincipal,
): Promise<AccessibleRepos> {
    const logger = rootLogger.child({ name: "listAccessibleRepos" });

    const orgIds = principal.organizationIds;
    if (orgIds.length === 0) return { repos: [], truncated: false, unreadable: [] };

    const orgs = await db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));

    // Each org's installation repo list is an independent GitHub App call, so fan them out.
    const listedPerOrg = await Promise.all(
        orgIds.map(async (organizationId) => {
            try {
                return { organizationId, listing: await github.listRepositories(organizationId) };
            } catch (err) {
                logger.warn("Failed to list installation repos for discovery", {
                    organizationId,
                    extra: { err },
                });
                return { organizationId, listing: { repos: [], unavailable: describeError(err) } };
            }
        }),
    );

    const all: AccessibleRepo[] = [];
    const unreadable: UnreadableOrganization[] = [];
    for (const { organizationId, listing } of listedPerOrg) {
        const organization = orgNameById.get(organizationId) ?? organizationId;
        if (listing.unavailable != null) unreadable.push({ organization, reason: listing.unavailable });
        for (const repo of listing.repos) {
            // Only repos linked to an Autonoma application are debuggable; a raw installation repo is not.
            if (repo.applicationId == null) continue;
            all.push({ repoFullName: repo.fullName, organization });
        }
    }
    all.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));

    const truncated = all.length > MAX_REPOS;
    const repos = all.slice(0, MAX_REPOS);

    logger.info("Listed accessible repos", {
        userId: principal.userId,
        extra: { count: repos.length, truncated, unreadableCount: unreadable.length },
    });
    return { repos, truncated, unreadable };
}
