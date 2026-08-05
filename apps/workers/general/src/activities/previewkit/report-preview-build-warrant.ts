import { analytics } from "@autonoma/analytics";
import { logger as rootLogger } from "@autonoma/logger";
import { type ReportPreviewBuildWarrantInput, warrantsBuild } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "reportPreviewBuildWarrant" });

/** PostHog event for every warrant - the one place the savings from unwarranted builds can be counted. */
const PREVIEW_BUILD_WARRANT_EVENT = "previewkit.build_warrant.decided";
/** PostHog group analytics key, so warrants break down per customer. */
const PREVIEW_BUILD_WARRANT_GROUP = "organization";

/**
 * Record whether this commit got a preview build, and why. Purely observational - the orchestrator has already
 * acted on the decision by the time this runs, and it treats a failure here as a warning, never a reason to change
 * what a customer gets.
 */
export async function reportPreviewBuildWarrant(input: ReportPreviewBuildWarrantInput): Promise<void> {
    const { organizationId, repoFullName, prNumber, headSha, branchId, snapshotId, reason, targetCount } = input;
    const build = warrantsBuild(reason);

    logger.info(build ? "Preview build warranted" : "Preview build not warranted", {
        organization: { organizationId },
        preview: { repo: repoFullName },
        extra: { pr: prNumber, headSha, branchId, snapshotId, reason, targetCount },
    });

    analytics.capture(
        organizationId,
        PREVIEW_BUILD_WARRANT_EVENT,
        { organizationId, repoFullName, prNumber, headSha, branchId, snapshotId, build, reason, targetCount },
        { [PREVIEW_BUILD_WARRANT_GROUP]: organizationId },
    );
}
