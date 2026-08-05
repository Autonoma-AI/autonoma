import { logger } from "@autonoma/logger";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { env } from "./env";
import { PreviewkitJobLauncher } from "./previewkit-job-launcher";

// The runner Jobs (plus the shared previewkit SA / env secret they mount) live in this dedicated control-cluster
// namespace; every launching pod creates Jobs here cross-namespace (see deployment/apps/previewkit.yaml).
const PREVIEWKIT_JOB_NAMESPACE = "previewkit";

let launcher: PreviewkitJobLauncher | undefined;

/**
 * Lazy: building it calls `loadFromCluster()`, so importing a module that can launch never needs a kubeconfig.
 */
export function getInClusterPreviewkitJobLauncher(): PreviewkitJobLauncher {
    if (launcher != null) return launcher;

    const kc = new KubeConfig();
    kc.loadFromCluster();
    launcher = new PreviewkitJobLauncher({
        batchApi: kc.makeApiClient(BatchV1Api),
        coreApi: kc.makeApiClient(CoreV1Api),
        jobNamespace: PREVIEWKIT_JOB_NAMESPACE,
        imageNamespace: env.NAMESPACE,
        databaseUrl: env.DATABASE_URL,
        sentryEnv: env.SENTRY_ENV,
        secretsCmk: env.PREVIEWKIT_SECRETS_CMK,
    });
    logger.info("Previewkit job launcher initialized", {
        extra: { jobNamespace: PREVIEWKIT_JOB_NAMESPACE, imageNamespace: env.NAMESPACE },
    });
    return launcher;
}
