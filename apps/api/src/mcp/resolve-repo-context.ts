import { db } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import type { GitHubInstallationService, ListedRepository } from "../github/github-installation.service";

/** The org + linked application an MCP tool call acts in, resolved from the `repoFullName` it names. */
export interface RepoContext {
    organizationId: string;
    applicationId: string;
    githubRepositoryId: number;
}

/**
 * Resolve the organization + application an MCP tool call acts in FROM the `repoFullName` ("owner/repo") it names.
 * The OAuth token carries only `userId`, and a user can be in many orgs, so we resolve per-repo and verify
 * membership - a token can only ever read orgs the user belongs to.
 *
 * `repoFullName` is stored on-DB only for repos that have a preview environment, so we can't rely on PreviewKit:
 * a diffs-only client is onboarded (an `Application` linked by numeric `githubRepositoryId`) but has no preview
 * env. So we use the org's GitHub App installation - the canonical source of "which repos does this org have" -
 * as the resolution path, keeping the PreviewKit row only as a fast DB shortcut.
 *
 * Throws `NotFoundError` (never an authorization-specific error) when no accessible application is found OR the
 * user isn't a member of the owning org: the two are indistinguishable, so a token can't probe repos in orgs the
 * user can't see.
 */
export async function resolveRepoContext(
    github: GitHubInstallationService,
    userId: string,
    repoFullName: string,
): Promise<RepoContext> {
    const logger = rootLogger.child({ name: "resolveRepoContext" });

    const memberships = await db.member.findMany({ where: { userId }, select: { organizationId: true } });
    const userOrgIds = memberships.map((membership) => membership.organizationId);
    if (userOrgIds.length === 0) throw notFound(repoFullName);

    // Fast path (no GitHub call): a preview environment already maps repoFullName -> org + numeric repo id.
    const fromPreview = await resolveViaPreviewkit(userOrgIds, repoFullName);
    if (fromPreview != null) {
        logger.info("Resolved repo context via preview environment", {
            organizationId: fromPreview.organizationId,
            extra: { repoFullName },
        });
        return fromPreview;
    }

    // Fallback: the repo string maps to an org/app only through the org's installation repo list (an Application
    // stores the numeric id, not "owner/repo"). Each org's list is an independent GitHub App call, so fan them
    // out; a stale/missing installation yields [] and is skipped.
    const perOrg = await Promise.all(
        userOrgIds.map(async (organizationId) => {
            try {
                return { organizationId, repos: await github.listRepositories(organizationId) };
            } catch (err) {
                logger.warn("Failed to list installation repos while resolving repo context", {
                    organizationId,
                    extra: { repoFullName, err },
                });
                return { organizationId, repos: [] as ListedRepository[] };
            }
        }),
    );

    const candidates: RepoContext[] = [];
    for (const { organizationId, repos } of perOrg) {
        const match = repos.find((repo) => repo.fullName === repoFullName && repo.applicationId != null);
        if (match?.applicationId != null) {
            candidates.push({ organizationId, applicationId: match.applicationId, githubRepositoryId: match.id });
        }
    }

    return pickSingleCandidate(candidates, repoFullName, logger);
}

async function resolveViaPreviewkit(userOrgIds: string[], repoFullName: string): Promise<RepoContext | undefined> {
    const envs = await db.previewkitEnvironment.findMany({
        where: { repoFullName, organizationId: { in: userOrgIds }, githubRepositoryId: { not: null } },
        select: { organizationId: true, githubRepositoryId: true },
        distinct: ["organizationId"],
    });
    // Two of the user's own orgs linking the same repo is ambiguous; fall through to the installation path,
    // which surfaces it as a disambiguation error rather than silently picking one org's data.
    if (envs.length !== 1) return undefined;

    const env = envs[0];
    if (env?.githubRepositoryId == null) return undefined;
    const app = await db.application.findFirst({
        where: { organizationId: env.organizationId, githubRepositoryId: env.githubRepositoryId },
        select: { id: true },
    });
    if (app == null) return undefined;
    return { organizationId: env.organizationId, applicationId: app.id, githubRepositoryId: env.githubRepositoryId };
}

function pickSingleCandidate(
    candidates: RepoContext[],
    repoFullName: string,
    logger: ReturnType<typeof rootLogger.child>,
): RepoContext {
    if (candidates.length === 0) throw notFound(repoFullName);
    if (candidates.length > 1) {
        throw new NotFoundError(
            `${repoFullName} is linked to more than one of your organizations; cannot disambiguate`,
        );
    }
    const context = candidates[0];
    if (context == null) throw notFound(repoFullName);
    logger.info("Resolved repo context via installation", {
        organizationId: context.organizationId,
        extra: { repoFullName, applicationId: context.applicationId },
    });
    return context;
}

// Same message for "no such repo/app" and "not a member" so a token cannot probe repos in orgs the user can't see.
function notFound(repoFullName: string): NotFoundError {
    return new NotFoundError(`No accessible Autonoma application found for ${repoFullName}`);
}
