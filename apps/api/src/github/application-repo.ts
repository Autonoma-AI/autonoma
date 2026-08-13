import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { RepositoryListing } from "./github-installation.service";

/** What an application's repository is called, and the numeric id it is stored under. */
export interface ApplicationRepo {
    /** "owner/repo". */
    fullName: string;
    githubRepositoryId: number;
}

/** The DB, plus one org's GitHub App installation repo list. */
export interface ApplicationRepoDeps {
    db: PrismaClient;
    /** `GitHubInstallationService.listRepositories` - the repos one org's installation can see. */
    listRepositories: (organizationId: string) => Promise<RepositoryListing>;
}

/**
 * An application's repository, or undefined when Autonoma cannot name one.
 *
 * An `Application` stores the numeric `githubRepositoryId`, never the string, so a caller holding
 * an application id cannot reach anything keyed by "owner/repo" without this. Both are returned
 * together because every caller that needs the name needs the id in the same breath, and they come
 * off the same row.
 *
 * The preview environment is tried first because it is a plain DB read and holds the name verbatim;
 * the installation listing is the fallback that apps deploying externally - and apps mid-onboarding,
 * whose first environment row does not exist yet - need.
 *
 * Best-effort by design: a GitHub outage answers undefined rather than throwing, so a caller can
 * degrade to asking for the repo instead of failing outright.
 */
export async function findApplicationRepo(
    { db, listRepositories }: ApplicationRepoDeps,
    organizationId: string,
    applicationId: string,
): Promise<ApplicationRepo | undefined> {
    const logger = rootLogger.child({ name: "findApplicationRepo" });

    const application = await db.application.findFirst({
        where: { id: applicationId, organizationId },
        select: { githubRepositoryId: true },
    });
    const githubRepositoryId = application?.githubRepositoryId;
    if (githubRepositoryId == null) {
        logger.info("Application has no linked GitHub repository", {
            organizationId,
            application: { applicationId },
        });
        return undefined;
    }

    const preview = await db.previewkitEnvironment.findFirst({
        where: { organizationId, githubRepositoryId },
        select: { repoFullName: true },
        orderBy: { createdAt: "desc" },
    });
    if (preview != null) return { fullName: preview.repoFullName, githubRepositoryId };

    try {
        const listing = await listRepositories(organizationId);
        const match = listing.repos.find((repo) => repo.applicationId === applicationId);
        if (match == null) return undefined;
        return { fullName: match.fullName, githubRepositoryId };
    } catch (err) {
        logger.warn("Could not resolve an application's repo name from GitHub", {
            organizationId,
            application: { applicationId },
            extra: { err },
        });
        return undefined;
    }
}
