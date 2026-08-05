import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { buildSdkUrl, recordBranchDeployment } from "@autonoma/test-updates";
import type { AttachPreviewDeploymentInput, AttachPreviewDeploymentOutput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "attachPreviewDeployment" });

/**
 * The SDK endpoint hangs off the app that implements the Environment Factory handler, which is not always the app
 * the tests browse - a split topology mounts it on its API service, and pointing a scenario up at the frontend
 * origin 404s.
 */
export async function attachPreviewDeployment(
    input: AttachPreviewDeploymentInput,
): Promise<AttachPreviewDeploymentOutput> {
    const { branchId, organizationId, url, sdkAppUrl } = input;
    logger.info("Attaching the branch deployment for a ready preview", {
        branch: { branchId },
        extra: { url, sdkAppUrl },
    });

    const deploymentId = await recordBranchDeployment({
        db,
        logger,
        branchId,
        organizationId,
        url,
        webhookUrl: buildSdkUrl(sdkAppUrl ?? url),
    });

    logger.info("Branch deployment attached", { branch: { branchId }, extra: { deploymentId } });
    return { deploymentId };
}
