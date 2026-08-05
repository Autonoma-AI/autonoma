import { getInClusterPreviewkitJobLauncher } from "@autonoma/k8s/previewkit-jobs";
import { logger as rootLogger } from "@autonoma/logger";
import type { CancelPreviewBuildInput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "cancelPreviewBuild" });

/**
 * Deletes by NAME, never by the environment label: the label is per (repo, PR), so a late label-scoped delete
 * would kill whichever newer commit had already launched.
 */
export async function cancelPreviewBuild(input: CancelPreviewBuildInput): Promise<void> {
    const { jobName } = input;
    logger.info("Cancelling the preview build for a superseded commit", { extra: { jobName } });

    await getInClusterPreviewkitJobLauncher().cancelDeploy(jobName);

    logger.info("Preview build cancelled", { extra: { jobName } });
}
