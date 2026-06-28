import { db } from "@autonoma/db";
import { triggerPreviewRedeployApp } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { PreviewkitTriggerService } from "./previewkit-trigger.service";
import { resolvePreviewkitTriggers } from "./previewkit-triggers";

/**
 * Starts the preview deploy/teardown lifecycle. `PREVIEWKIT_EXECUTION_MODE`
 * selects the backend (Temporal workflow or a Kubernetes Job per deploy) behind
 * the same trigger seam. Used by the public `/v1/previewkit/*` router and the
 * GitHub webhook handler; gated by `PREVIEWKIT_ENABLED` at the call sites.
 * Mirrors the diffs wiring in `../diffs/diffs-service.ts`.
 */
const triggers = resolvePreviewkitTriggers();

export const previewkitTriggerService = new PreviewkitTriggerService(
    db,
    new GitHubInstallationService(db, buildGitHubApp(env)),
    triggers.deploy,
    triggers.teardown,
    triggerPreviewRedeployApp,
);
