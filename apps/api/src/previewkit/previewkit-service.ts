import { db } from "@autonoma/db";
import { triggerPreviewDeploy, triggerPreviewRedeployApp, triggerPreviewTeardown } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { PreviewkitTriggerService } from "./previewkit-trigger.service";

/**
 * Starts the preview lifecycle Temporal workflows (the previewkit worker
 * executes them). Used by the public `/v1/previewkit/*` router and the GitHub
 * webhook handler; gated by `PREVIEWKIT_ENABLED` at the call sites. Mirrors
 * the diffs wiring in `../diffs/diffs-service.ts`.
 */
export const previewkitTriggerService = new PreviewkitTriggerService(
    db,
    new GitHubInstallationService(db, buildGitHubApp(env)),
    triggerPreviewDeploy,
    triggerPreviewTeardown,
    triggerPreviewRedeployApp,
);
