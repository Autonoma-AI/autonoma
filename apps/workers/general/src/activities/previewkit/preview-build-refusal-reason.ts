import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { PreviewDeployTarget } from "@autonoma/types";

/**
 * Why the runner would refuse to deploy this target, or undefined when it has what it needs. Resolves the pair the
 * way `PreviewPipeline.prepare` does - from `(organizationId, githubRepositoryId)`, not through the branch
 * `resolvePreviewTarget` used - so an Application unlinked since then is caught. Missing a condition here only
 * costs a short-lived Job: `readPreviewBuildJobState` still observes the runner's own refusal.
 */
export async function previewBuildRefusalReason(target: PreviewDeployTarget): Promise<string | undefined> {
    const logger = rootLogger.child({ name: "previewBuildRefusalReason" });
    const { repoFullName, organizationId, githubRepositoryId } = target;

    const application = await db.application.findUnique({
        where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
        select: { id: true, previewkitConfig: { select: { id: true } } },
    });

    const ids = { organization: { organizationId }, preview: { repo: repoFullName } };

    if (application == null) {
        logger.warn("No application owns this repository; a deploy would decline", {
            ...ids,
            extra: { githubRepositoryId },
        });
        return `${repoFullName} is not linked to an Autonoma application`;
    }

    if (application.previewkitConfig == null) {
        logger.warn("Application is previewkit-managed but has no preview config; a deploy would decline", {
            ...ids,
            application: { applicationId: application.id },
        });
        return `${repoFullName} has no preview environment configuration`;
    }

    logger.info("The runner has what it needs to deploy this commit", {
        ...ids,
        application: { applicationId: application.id },
    });
    return undefined;
}
