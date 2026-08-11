import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { recordBranchDeployment } from "@autonoma/scenario";
import { buildSdkUrl, sdkPathFromDocument } from "@autonoma/types";
import type { AttachPreviewDeploymentInput, AttachPreviewDeploymentOutput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "attachPreviewDeployment" });

/**
 * The SDK endpoint hangs off the app that implements the Environment Factory handler, which is not always the app
 * the tests browse - a split topology mounts it on its API service, and pointing a scenario up at the frontend
 * origin 404s. Nor is it always at the conventional path, which is what the config's `sdk_path` says.
 */
export async function attachPreviewDeployment(
    input: AttachPreviewDeploymentInput,
): Promise<AttachPreviewDeploymentOutput> {
    const { branchId, organizationId, url, sdkAppUrl } = input;
    logger.info("Attaching the branch deployment for a ready preview", {
        branch: { branchId },
        extra: { url, sdkAppUrl },
    });

    const sdkPath = await resolveConfiguredSdkPath(branchId);

    const deploymentId = await recordBranchDeployment({
        db,
        branchId,
        organizationId,
        url,
        webhookUrl: buildSdkUrl(sdkAppUrl ?? url, sdkPath),
    });

    logger.info("Branch deployment attached", { branch: { branchId }, extra: { deploymentId, sdkPath } });
    return { deploymentId };
}

/**
 * The `sdk_path` the branch's application declares, or undefined when it declares none (including every
 * application with no preview config at all, whose endpoint then follows the convention).
 *
 * Read here rather than carried on the activity input: the path is a property of the handler's code, so the config
 * is its source of truth, and resolving it at write time keeps the endpoint this run persists honest about where
 * the provision will actually land.
 */
async function resolveConfiguredSdkPath(branchId: string): Promise<string | undefined> {
    const branch = await db.branch.findUnique({
        where: { id: branchId },
        select: { application: { select: { previewkitConfig: { select: { document: true } } } } },
    });

    const document = branch?.application.previewkitConfig?.document;
    if (document == null) return undefined;
    return sdkPathFromDocument(document);
}
