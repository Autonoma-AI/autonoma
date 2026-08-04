import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import type { RepositoryListing } from "../github/github-installation.service";
import type { McpPrincipal } from "./mcp-principal";
import { describeError } from "./tool-result";

/** The org + linked application an MCP tool call acts in, resolved from the `repoFullName` it names. */
export interface RepoContext {
    organizationId: string;
    applicationId: string;
    githubRepositoryId: number;
}

/** What {@link resolveRepoContext} needs: the DB, plus one org's GitHub App installation repo list. */
export interface RepoContextDeps {
    db: PrismaClient;
    /** `GitHubInstallationService.listRepositories` - the repos one org's installation can see. */
    listRepositories: (organizationId: string) => Promise<RepositoryListing>;
}

/**
 * Resolve the organization + application an MCP tool call acts in FROM the `repoFullName` ("owner/repo") it names.
 * A credential can span several orgs (an OAuth token covers every org its user belongs to), so we resolve
 * per-repo against the principal's authorized orgs - resolution can only ever reach orgs already on it.
 *
 * `repoFullName` is stored on-DB only for repos that have a preview environment, so we can't rely on PreviewKit:
 * a diffs-only client is onboarded (an `Application` linked by numeric `githubRepositoryId`) but has no preview
 * env. So we use the org's GitHub App installation - the canonical source of "which repos does this org have" -
 * as the resolution path, keeping the PreviewKit row only as a fast DB shortcut.
 *
 * Throws `NotFoundError` (never an authorization-specific error) when no accessible application is found OR the
 * repo is outside the principal's orgs: the two are indistinguishable, so a credential can't probe repos it
 * cannot reach.
 */
export async function resolveRepoContext(
    { db, listRepositories }: RepoContextDeps,
    principal: McpPrincipal,
    repoFullName: string,
): Promise<RepoContext> {
    const logger = rootLogger.child({ name: "resolveRepoContext" });

    const userOrgIds = principal.organizationIds;
    if (userOrgIds.length === 0) throw notFound(repoFullName);

    // Fast path (no GitHub call): a preview environment already maps repoFullName -> org + numeric repo id.
    const fromPreview = await resolveViaPreviewkit(db, userOrgIds, repoFullName);
    if (fromPreview != null) {
        logger.info("Resolved repo context via preview environment", {
            organizationId: fromPreview.organizationId,
            extra: { repoFullName },
        });
        return fromPreview;
    }

    // Fallback: the repo string maps to an org/app only through the org's installation repo list (an Application
    // stores the numeric id, not "owner/repo"). Each org's list is an independent GitHub App call, so fan them out.
    const perOrg = await Promise.all(
        userOrgIds.map(async (organizationId) => {
            try {
                return { organizationId, listing: await listRepositories(organizationId) };
            } catch (err) {
                logger.warn("Failed to list installation repos while resolving repo context", {
                    organizationId,
                    extra: { repoFullName, err },
                });
                return { organizationId, listing: { repos: [], unavailable: describeError(err) } };
            }
        }),
    );

    const candidates: RepoContext[] = [];
    const unreadable: string[] = [];
    for (const { organizationId, listing } of perOrg) {
        if (listing.unavailable != null) unreadable.push(listing.unavailable);
        const match = listing.repos.find((repo) => repo.fullName === repoFullName && repo.applicationId != null);
        if (match?.applicationId != null) {
            candidates.push({ organizationId, applicationId: match.applicationId, githubRepositoryId: match.id });
        }
    }

    // An org whose installation could not be read might well be the one holding this repo, so
    // "no accessible application" would be a guess. Name the installation problem instead.
    if (candidates.length === 0 && unreadable.length > 0) {
        throw new NotFoundError(
            `Could not determine whether ${repoFullName} belongs to one of your organizations, because Autonoma ` +
                `could not read an organization's repositories from GitHub. ${unreadable.join(" ")}`,
        );
    }

    return pickSingleCandidate(candidates, repoFullName, logger);
}

async function resolveViaPreviewkit(
    db: PrismaClient,
    userOrgIds: string[],
    repoFullName: string,
): Promise<RepoContext | undefined> {
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
