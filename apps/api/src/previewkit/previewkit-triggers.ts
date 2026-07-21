import { logger } from "@autonoma/logger";
import type {
    TriggerPreviewDeployParams,
    TriggerPreviewRedeployAppParams,
    TriggerPreviewTeardownParams,
} from "@autonoma/types";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { env } from "../env";
import { PreviewkitJobLauncher } from "./previewkit-job-launcher";

/**
 * The fire-and-forget seam PreviewkitTriggerService is constructed with. The
 * preview lifecycle runs as one Kubernetes Job per operation (deploy / teardown
 * / per-app redeploy) via {@link PreviewkitJobLauncher}; this seam keeps the
 * trigger service - and every caller (webhooks, HTTP routes, admin redeploy) -
 * decoupled from how the Job is launched.
 */
export interface PreviewkitTriggers {
    deploy: (params: TriggerPreviewDeployParams) => Promise<void>;
    teardown: (params: TriggerPreviewTeardownParams) => Promise<void>;
    redeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>;
}

// The runner Jobs (plus the shared previewkit SA / env secret they mount) live
// in this dedicated control-cluster namespace; the API creates Jobs here
// cross-namespace (see deployment/apps/previewkit.yaml).
const PREVIEWKIT_JOB_NAMESPACE = "previewkit";

let launcher: PreviewkitJobLauncher | undefined;

/**
 * Lazily builds the in-cluster launcher on first use. Deferred (not built at
 * module load) so importing this module never touches a kubeconfig: dev/test
 * and any environment with `PREVIEWKIT_ENABLED=false` never invoke a trigger,
 * so `loadFromCluster()` only runs in a real preview-enabled API pod.
 */
function getLauncher(): PreviewkitJobLauncher {
    if (launcher != null) return launcher;
    if (env.NAMESPACE == null) {
        throw new Error("NAMESPACE is required to launch previewkit Jobs");
    }
    const kc = new KubeConfig();
    kc.loadFromCluster();
    // The runner image is read at launch from the per-env previewkit-runner-image
    // ConfigMap in the API's own namespace (env.NAMESPACE), so each environment
    // pins its own runner image; the Job is then created in the shared previewkit
    // namespace with that image. No image is wired through the API env directly.
    // DATABASE_URL is baked in from this API's own env so the runner writes to the
    // same DB this API reads from (overriding the shared env secret's prod DB URL).
    launcher = new PreviewkitJobLauncher({
        batchApi: kc.makeApiClient(BatchV1Api),
        coreApi: kc.makeApiClient(CoreV1Api),
        jobNamespace: PREVIEWKIT_JOB_NAMESPACE,
        imageNamespace: env.NAMESPACE,
        databaseUrl: env.DATABASE_URL,
        temporalAddress: env.TEMPORAL_ADDRESS,
        temporalNamespace: env.TEMPORAL_NAMESPACE,
        sentryEnv: env.SENTRY_ENV,
    });
    logger.info("Previewkit launcher initialized", {
        extra: { jobNamespace: PREVIEWKIT_JOB_NAMESPACE, imageNamespace: env.NAMESPACE },
    });
    return launcher;
}

/** The preview lifecycle triggers - each launches a Kubernetes Job. */
export function resolvePreviewkitTriggers(): PreviewkitTriggers {
    return {
        deploy: (params) => getLauncher().launchDeploy(params),
        teardown: (params) => getLauncher().launchTeardown(params),
        redeployApp: (params) => getLauncher().launchRedeployApp(params),
    };
}
