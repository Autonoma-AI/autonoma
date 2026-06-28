import { logger } from "@autonoma/logger";
import {
    type TriggerPreviewDeployParams,
    type TriggerPreviewTeardownParams,
    triggerPreviewDeploy,
    triggerPreviewTeardown,
} from "@autonoma/workflow";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { env } from "../env";
import { PreviewkitJobLauncher } from "./previewkit-job-launcher";

/**
 * The fire-and-forget seam PreviewkitTriggerService is constructed with. Both
 * the Temporal path and the Kubernetes Jobs path satisfy it, so the trigger
 * service - and every caller (webhooks, HTTP routes, admin redeploy) - is
 * identical regardless of PREVIEWKIT_EXECUTION_MODE.
 */
export interface PreviewkitTriggers {
    deploy: (params: TriggerPreviewDeployParams) => Promise<void>;
    teardown: (params: TriggerPreviewTeardownParams) => Promise<void>;
}

let cached: PreviewkitTriggers | undefined;

/**
 * Resolves how preview deploys/teardowns are triggered, memoized per process.
 * "jobs" builds an in-cluster {@link PreviewkitJobLauncher} (lazily, so the
 * default "temporal" path never touches a kubeconfig in dev/test).
 */
export function resolvePreviewkitTriggers(): PreviewkitTriggers {
    if (cached != null) return cached;
    cached = env.PREVIEWKIT_EXECUTION_MODE === "jobs" ? jobsTriggers() : temporalTriggers();
    return cached;
}

function temporalTriggers(): PreviewkitTriggers {
    return { deploy: triggerPreviewDeploy, teardown: triggerPreviewTeardown };
}

function jobsTriggers(): PreviewkitTriggers {
    if (env.NAMESPACE == null) {
        throw new Error("NAMESPACE is required when PREVIEWKIT_EXECUTION_MODE=jobs");
    }
    const kc = new KubeConfig();
    kc.loadFromCluster();
    // The runner image is read at launch from the previewkit-runner-image
    // ConfigMap (written by the previewkit deploy), so it is SHA-pinned to the
    // currently-deployed previewkit image - no image is wired through the API env.
    const launcher = new PreviewkitJobLauncher({
        batchApi: kc.makeApiClient(BatchV1Api),
        coreApi: kc.makeApiClient(CoreV1Api),
        namespace: env.NAMESPACE,
    });
    logger.info("Previewkit lifecycle uses Kubernetes Jobs", { extra: { namespace: env.NAMESPACE } });
    return {
        deploy: (params) => launcher.launchDeploy(params),
        teardown: (params) => launcher.launchTeardown(params),
    };
}
