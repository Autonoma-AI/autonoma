import { db } from "@autonoma/db";
import { EksKubeconfigLoader } from "@autonoma/k8s/eks";
import { ClusterPreviewNamespaces, PreviewReaper } from "@autonoma/k8s/preview-reaper";
import { runWithSentry } from "@autonoma/logger";
import { captureCheckIn } from "@sentry/node";
import { env } from "./env";

const JOB_NAME = "preview-environment-reaper";

async function main() {
    const checkInId = captureCheckIn({ monitorSlug: JOB_NAME, status: "in_progress" });

    try {
        const kubeConfig = await new EksKubeconfigLoader(env.PREVIEWKIT_EKS_CLUSTER_NAME, env.AWS_REGION, {
            endpoint: env.PREVIEWKIT_EKS_CLUSTER_ENDPOINT,
            caData: env.PREVIEWKIT_EKS_CLUSTER_CA,
        }).load();

        const reaper = new PreviewReaper(db, new ClusterPreviewNamespaces(kubeConfig));
        const result = await reaper.run(new Date(), { dryRun: env.DRY_RUN });

        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "ok" });
        return result;
    } catch (error) {
        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "error" });
        throw error;
    }
}

runWithSentry({ name: JOB_NAME }, async () => {
    const result = await main();
    console.log(`Preview environment reconciliation complete: ${JSON.stringify(result)}`);
});
