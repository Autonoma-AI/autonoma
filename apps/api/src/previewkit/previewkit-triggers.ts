import { logger } from "@autonoma/logger";
import type {
    TriggerPreviewDeployParams,
    TriggerPreviewRedeployAppParams,
    TriggerPreviewTeardownParams,
} from "@autonoma/types";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
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

// All previewkit resources (runner Jobs + their SA / secret / ConfigMaps, and
// the buildkitd Jobs) live in this dedicated control-cluster namespace - the
// API creates runner Jobs here cross-namespace (see deployment/apps/previewkit.yaml).
const PREVIEWKIT_NAMESPACE = "previewkit";

let launcher: PreviewkitJobLauncher | undefined;

/**
 * Lazily builds the in-cluster launcher on first use. Deferred (not built at
 * module load) so importing this module never touches a kubeconfig: dev/test
 * and any environment with `PREVIEWKIT_ENABLED=false` never invoke a trigger,
 * so `loadFromCluster()` only runs in a real preview-enabled API pod.
 */
function getLauncher(): PreviewkitJobLauncher {
    if (launcher != null) return launcher;
    const kc = new KubeConfig();
    kc.loadFromCluster();
    // The runner image is read at launch from the previewkit-runner-image
    // ConfigMap (written by the previewkit deploy), so it is SHA-pinned to the
    // currently-deployed previewkit image - no image is wired through the API env.
    launcher = new PreviewkitJobLauncher({
        batchApi: kc.makeApiClient(BatchV1Api),
        coreApi: kc.makeApiClient(CoreV1Api),
        namespace: PREVIEWKIT_NAMESPACE,
    });
    logger.info("Previewkit launcher initialized", { extra: { namespace: PREVIEWKIT_NAMESPACE } });
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
