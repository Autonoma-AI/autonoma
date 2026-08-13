import { db } from "@autonoma/db";
import { OctokitGitHubApp } from "@autonoma/github";
import { hasGoneLive } from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import { autonomaHostsPreviews } from "@autonoma/scenario";
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
                    previewDeployRef: true,
                    onboardingState: { select: { previewEnvironmentMode: true, step: true } },
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
    // Read once here rather than in the workflow: this query already joins the onboarding row, so
    // asking for the step costs nothing, and a second activity to fetch it would be a round trip
    // for a column we already had in hand.
    const onboardingComplete = hasGoneLive(application.onboardingState?.step);
    if (!autonomaHostsPreviews(application.onboardingState?.previewEnvironmentMode)) {
        logger.info("The customer deploys this preview; the run is analysis only", {
            branch: { branchId },
            extra: { mode: application.onboardingState?.previewEnvironmentMode, hasRecordedPreview },
        });
        return { organizationId, hasRecordedPreview, onboardingComplete };
    }
    if (application.githubRepositoryId == null) {
        logger.warn("Application is previewkit-managed but linked to no repository; cannot build a preview", {
            branch: { branchId },
        });
        return { organizationId, hasRecordedPreview, onboardingComplete };
    }

    const repoFullName = await resolveRepoFullName(organizationId, application.githubRepositoryId);
    if (repoFullName == null) return { organizationId, hasRecordedPreview, onboardingComplete };

    const prNumber = branch.prInfo?.prNumber ?? MAIN_BRANCH_ENVIRONMENT_NUMBER;
    // The base environment follows the app's pinned deploy ref, which is deliberately NOT the
    // Branch record: that record is the app's trunk identity and drives suite lineage and every
    // "main" label in the product, so pointing it at an integration branch would redefine what
    // main means (see setDeployBranch). Taking the ref from the record instead handed the builder
    // the trunk's NAME with the integration branch's SHA - a mismatched pair, and the wrong branch
    // for the deploy that was asked for. A PR environment has its own head and never consults this.
    const headRef =
        prNumber === MAIN_BRANCH_ENVIRONMENT_NUMBER ? (application.previewDeployRef ?? branch.name) : branch.name;

    logger.info("This run owns a previewkit preview", {
        organization: { organizationId },
        branch: { branchId },
        preview: { repo: repoFullName, headRef },
        extra: { pr: prNumber },
    });

    return {
        organizationId,
        hasRecordedPreview,
        onboardingComplete,
        target: {
            repoFullName,
            prNumber,
            organizationId,
            githubRepositoryId: application.githubRepositoryId,
            headSha,
            headRef,
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
