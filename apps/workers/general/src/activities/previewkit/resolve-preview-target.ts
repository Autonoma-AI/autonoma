import { db } from "@autonoma/db";
import { OctokitGitHubApp } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { autonomaHostsPreviews } from "@autonoma/test-updates";
import type { ResolvePreviewTargetInput, ResolvePreviewTargetOutput } from "@autonoma/workflow/activities";
import { env } from "../../env";

const logger = rootLogger.child({ name: "resolvePreviewTarget" });

/** PR numbers start at 1, so 0 is the main branch's stable non-PR environment. */
const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

/**
 * Who owns a branch's preview is a fact about the APPLICATION, not about whichever trigger started the run - which
 * is what lets a push, a `/start analysis` comment and a label all be the same call.
 */
export async function resolvePreviewTarget(input: ResolvePreviewTargetInput): Promise<ResolvePreviewTargetOutput> {
    const { branchId, headSha } = input;
    logger.info("Resolving whether this run owns a preview", { branch: { branchId } });

    const branch = await db.branch.findUnique({
        where: { id: branchId },
        select: {
            name: true,
            deploymentId: true,
            prInfo: { select: { prNumber: true } },
            application: {
                select: {
                    organizationId: true,
                    githubRepositoryId: true,
                    onboardingState: { select: { previewEnvironmentMode: true } },
                },
            },
        },
    });

    const application = branch?.application;
    if (branch == null || application == null) {
        logger.info("No application for this branch; the run owns no preview", { branch: { branchId } });
        return { hasRecordedPreview: false };
    }

    const hasRecordedPreview = branch.deploymentId != null;
    const organizationId = application.organizationId;
    if (!autonomaHostsPreviews(application.onboardingState?.previewEnvironmentMode)) {
        logger.info("The customer deploys this preview; the run is analysis only", {
            branch: { branchId },
            extra: { mode: application.onboardingState?.previewEnvironmentMode, hasRecordedPreview },
        });
        return { organizationId, hasRecordedPreview };
    }
    if (application.githubRepositoryId == null) {
        logger.warn("Application is previewkit-managed but linked to no repository; cannot build a preview", {
            branch: { branchId },
        });
        return { organizationId, hasRecordedPreview };
    }

    const repoFullName = await resolveRepoFullName(organizationId, application.githubRepositoryId);
    if (repoFullName == null) return { organizationId, hasRecordedPreview };

    const prNumber = branch.prInfo?.prNumber ?? MAIN_BRANCH_ENVIRONMENT_NUMBER;

    logger.info("This run owns a previewkit preview", {
        organization: { organizationId },
        branch: { branchId },
        preview: { repo: repoFullName, headRef: branch.name },
        extra: { pr: prNumber },
    });

    return {
        organizationId,
        hasRecordedPreview,
        target: {
            repoFullName,
            prNumber,
            organizationId,
            githubRepositoryId: application.githubRepositoryId,
            headSha,
            headRef: branch.name,
            branchId,
        },
    };
}

/**
 * Resolved from GitHub rather than stored: `githubRepositoryId` is the stable identity and a repo can be renamed,
 * so a persisted name would go quietly stale. A live preview already knows it, which saves the call.
 */
async function resolveRepoFullName(organizationId: string, githubRepositoryId: number): Promise<string | undefined> {
    const known = await db.previewkitEnvironment.findFirst({
        where: { organizationId, githubRepositoryId },
        select: { repoFullName: true },
        orderBy: { createdAt: "desc" },
    });
    if (known != null) return known.repoFullName;

    const installation = await db.gitHubInstallation.findUnique({
        where: { organizationId },
        select: { installationId: true },
    });
    if (installation == null) {
        logger.warn("Organization has no GitHub installation; cannot resolve the repository", {
            organization: { organizationId },
        });
        return undefined;
    }

    const app = new OctokitGitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });
    const client = await app.getInstallationClient(installation.installationId);
    const repo = await client.getRepository(githubRepositoryId);
    return repo.fullName;
}
