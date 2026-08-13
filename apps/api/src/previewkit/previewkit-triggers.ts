import { getInClusterPreviewkitJobLauncher } from "@autonoma/k8s/previewkit-jobs";
import type { TriggerPreviewRedeployAppParams, PreviewTeardownTarget } from "@autonoma/types";
import {
    type AnalysisRunWorkflowInput,
    type PreviewBuildWorkflowInput,
    triggerAnalysisRun,
    triggerPreviewBuild,
} from "@autonoma/workflow";

/**
 * The fire-and-forget seam PreviewkitTriggerService is constructed with, keeping the trigger service - and every
 * caller (webhooks, HTTP routes, admin redeploy) - decoupled from how each operation is carried out.
 *
 * `startPreviewBuild` is for the two cases with no run behind them: a repo with no Application, and a redeploy.
 * Teardown and per-app redeploy have no decision to make, so they launch their Kubernetes Job straight from here.
 */
export interface PreviewkitTriggers {
    /** Returns the Temporal workflow id, so a caller can name what it queued. */
    startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<string>;
    startPreviewBuild: (input: PreviewBuildWorkflowInput) => Promise<void>;
    teardown: (target: PreviewTeardownTarget) => Promise<void>;
    redeployApp: (params: TriggerPreviewRedeployAppParams) => Promise<void>;
}

/** The preview lifecycle triggers - each launches a Kubernetes Job. */
export function resolvePreviewkitTriggers(): PreviewkitTriggers {
    return {
        startAnalysisRun: triggerAnalysisRun,
        startPreviewBuild: triggerPreviewBuild,
        teardown: (target) => getInClusterPreviewkitJobLauncher().launchTeardown(target),
        redeployApp: (params) => getInClusterPreviewkitJobLauncher().launchRedeployApp(params),
    };
}
