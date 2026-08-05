import type { GeneralActivities, PreviewkitActivities } from "@autonoma/workflow/activities";

export { scenarioUp, scenarioDown } from "./scenario";
export { notifyGenerationExit } from "./notify-generation-exit";
export { markGenerationFailed } from "./mark-generation-failed";

// The previewkit build warrant's steps. None needs a heartbeat - the hours-long wait lives in the build workflow's
// poll loop. They sit on this queue because none clones a repository, and launching a Job needs RBAC only this
// pod's service account holds.
export { attachPreviewDeployment } from "./previewkit/attach-preview-deployment";
export { cancelPreviewBuild } from "./previewkit/cancel-preview-build";
export { hasBranchEverBuiltPreview } from "./previewkit/has-branch-ever-built-preview";
export { launchPreviewBuild } from "./previewkit/launch-preview-build";
export { readPreviewBuildJobState } from "./previewkit/read-preview-build-job-state";
export { readPreviewBuildStatus } from "./previewkit/read-preview-build-status";
export { resolvePreviewTarget } from "./previewkit/resolve-preview-target";
export { reportPreviewBuildWarrant } from "./previewkit/report-preview-build-warrant";

import { markGenerationFailed } from "./mark-generation-failed";
import { notifyGenerationExit } from "./notify-generation-exit";
import { attachPreviewDeployment } from "./previewkit/attach-preview-deployment";
import { cancelPreviewBuild } from "./previewkit/cancel-preview-build";
import { hasBranchEverBuiltPreview } from "./previewkit/has-branch-ever-built-preview";
import { launchPreviewBuild } from "./previewkit/launch-preview-build";
import { readPreviewBuildJobState } from "./previewkit/read-preview-build-job-state";
import { readPreviewBuildStatus } from "./previewkit/read-preview-build-status";
import { reportPreviewBuildWarrant } from "./previewkit/report-preview-build-warrant";
import { resolvePreviewTarget } from "./previewkit/resolve-preview-target";
import { scenarioDown, scenarioUp } from "./scenario";

// Compile-time check: ensure exported activities match the GeneralActivities contract.
({ scenarioUp, scenarioDown, notifyGenerationExit, markGenerationFailed }) satisfies GeneralActivities;

// Compile-time check: the previewkit build warrant's steps satisfy their contract.
({
    attachPreviewDeployment,
    cancelPreviewBuild,
    hasBranchEverBuiltPreview,
    launchPreviewBuild,
    readPreviewBuildJobState,
    readPreviewBuildStatus,
    reportPreviewBuildWarrant,
    resolvePreviewTarget,
}) satisfies PreviewkitActivities;
