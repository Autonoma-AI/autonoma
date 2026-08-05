import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { HasBranchEverBuiltPreviewInput, HasBranchEverBuiltPreviewOutput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "hasBranchEverBuiltPreview" });

/**
 * `deployedAt`, not `status` or a build row: `status` flips back to `pending` on every redeploy, and no build row
 * ever reaches `ready` (readiness is the environment's verdict). `deployedAt` is stamped once and never cleared,
 * so an in-flight build correctly does not count.
 */
export async function hasBranchEverBuiltPreview(
    input: HasBranchEverBuiltPreviewInput,
): Promise<HasBranchEverBuiltPreviewOutput> {
    const { branchId } = input;
    logger.info("Checking whether the branch has ever built a preview", { branch: { branchId } });

    const previewed = await db.previewkitEnvironment.findFirst({
        where: { branchId, deployedAt: { not: null } },
        select: { id: true },
    });

    const everBuilt = previewed != null;
    logger.info("Branch preview history resolved", { branch: { branchId }, extra: { everBuilt } });
    return { everBuilt };
}
