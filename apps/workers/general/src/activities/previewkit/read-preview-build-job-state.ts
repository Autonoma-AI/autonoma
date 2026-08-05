import { getInClusterPreviewkitJobLauncher } from "@autonoma/k8s/previewkit-jobs";
import { logger as rootLogger } from "@autonoma/logger";
import type { ReadPreviewBuildJobStateInput, ReadPreviewBuildJobStateOutput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "readPreviewBuildJobState" });

export async function readPreviewBuildJobState(
    input: ReadPreviewBuildJobStateInput,
): Promise<ReadPreviewBuildJobStateOutput> {
    const { jobName } = input;
    logger.info("Reading the preview build Job state", { extra: { jobName } });

    const state = await getInClusterPreviewkitJobLauncher().getDeployJobState(jobName);

    logger.info("Preview build Job state read", { extra: { jobName, state } });
    return { state };
}
