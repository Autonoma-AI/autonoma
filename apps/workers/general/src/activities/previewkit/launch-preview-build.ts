import { getInClusterPreviewkitJobLauncher, previewEnvKey } from "@autonoma/k8s/previewkit-jobs";
import { logger as rootLogger } from "@autonoma/logger";
import type { LaunchPreviewBuildInput, LaunchPreviewBuildOutput } from "@autonoma/workflow/activities";
import { previewBuildRefusalReason } from "./preview-build-refusal-reason";

const logger = rootLogger.child({ name: "launchPreviewBuild" });

/**
 * This pod's `worker-general` service account has to be a subject of the `previewkit-job-launcher-ephemeral`
 * RoleBinding (Job create/get in `previewkit`) and of `api-role` (`configmaps: get`, for the runner-image ConfigMap).
 */
export async function launchPreviewBuild(input: LaunchPreviewBuildInput): Promise<LaunchPreviewBuildOutput> {
    const { target } = input;
    const envKey = previewEnvKey(target.repoFullName, target.prNumber);
    const ids = { organization: { organizationId: target.organizationId }, preview: { repo: target.repoFullName } };
    logger.info("Launching the preview build", {
        ...ids,
        extra: { envKey, pr: target.prNumber, headSha: target.headSha },
    });

    const declined = await previewBuildRefusalReason(target);
    if (declined != null) {
        logger.warn("Declining the preview build instead of scheduling a Job that would decline on arrival", {
            ...ids,
            extra: { envKey, pr: target.prNumber, headSha: target.headSha, declined },
        });
        return { declined };
    }

    const jobName = await getInClusterPreviewkitJobLauncher().launchDeploy(target);

    logger.info("Preview build Job created", { ...ids, extra: { envKey, jobName } });
    return { jobName };
}
