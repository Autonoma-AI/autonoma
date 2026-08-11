import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

/** Header that clears the previewkit Gatekeeper, so a webhook call reaches a sleeping preview instead of the proxy. */
const PREVIEWKIT_BYPASS_HEADER = "x-previewkit-bypass";

const logger = rootLogger.child({ name: "recordBranchDeployment" });

export interface RecordBranchDeploymentParams {
    db: PrismaClient;
    branchId: string;
    organizationId: string;
    /** The origin the branch's tests run against. */
    url: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
}

/**
 * Called whenever the URL becomes known: a customer-deployed preview has one when its trigger arrives, a
 * previewkit preview only once its build is live.
 */
export async function recordBranchDeployment({
    db,
    branchId,
    organizationId,
    url,
    webhookUrl,
    webhookHeaders,
}: RecordBranchDeploymentParams): Promise<string> {
    logger.info("Recording branch deployment", { branch: { branchId }, extra: { url } });

    const mergedWebhookHeaders = await withPreviewkitBypassHeader({ db, url, webhookHeaders });

    return await db.$transaction(async (tx) => {
        const deployment = await tx.branchDeployment.create({
            data: {
                branchId,
                organizationId,
                webhookUrl,
                webhookHeaders: mergedWebhookHeaders,
                webDeployment: { create: { url, organizationId } },
            },
        });

        await tx.branch.update({ where: { id: branchId }, data: { deploymentId: deployment.id } });

        logger.info("Branch deployment recorded", {
            branch: { branchId },
            extra: { deploymentId: deployment.id, url },
        });
        return deployment.id;
    });
}

/**
 * Add the bypass header when the URL belongs to a previewkit preview. Anything else (a customer's own deployment)
 * keeps its headers untouched, since there is no Gatekeeper in front of it.
 */
async function withPreviewkitBypassHeader({
    db,
    url,
    webhookHeaders,
}: Pick<RecordBranchDeploymentParams, "db" | "url" | "webhookHeaders">): Promise<Record<string, string> | undefined> {
    const instance = await db.previewkitAppInstance.findFirst({
        where: { url },
        select: { environment: { select: { bypassToken: true } } },
    });

    const bypassToken = instance?.environment.bypassToken;
    if (bypassToken == null) {
        logger.info("No previewkit bypass token for deployment URL; webhook headers unchanged", { extra: { url } });
        return webhookHeaders;
    }

    logger.info("Injecting previewkit bypass header into webhook headers", { extra: { url } });
    return { ...(webhookHeaders ?? {}), [PREVIEWKIT_BYPASS_HEADER]: bypassToken };
}
