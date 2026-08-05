import { getInClusterPreviewkitJobLauncher, previewEnvKey } from "@autonoma/k8s/previewkit-jobs";
import { logger as rootLogger } from "@autonoma/logger";
import type { LaunchPreviewBuildInput, LaunchPreviewBuildOutput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "launchPreviewBuild" });

/**
 * This pod's `worker-general` service account has to be a subject of the `previewkit-job-launcher-ephemeral`
 * RoleBinding (Job create in `previewkit`) and of `api-role` (`configmaps: get`, for the runner-image ConfigMap).
 */
export async function launchPreviewBuild(input: LaunchPreviewBuildInput): Promise<LaunchPreviewBuildOutput> {
    const { target } = input;
    const envKey = previewEnvKey(target.repoFullName, target.prNumber);
    logger.info("Launching the preview build", {
        organization: { organizationId: target.organizationId },
        preview: { repo: target.repoFullName },
        extra: { envKey, pr: target.prNumber, headSha: target.headSha },
    });

    const jobName = await getInClusterPreviewkitJobLauncher().launchDeploy(target);

    logger.info("Preview build Job created", { preview: { repo: target.repoFullName }, extra: { envKey, jobName } });
    return { jobName };
}
