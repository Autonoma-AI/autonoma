import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { PreviewkitTriggerService } from "./previewkit-trigger.service";
import { resolvePreviewkitTriggers } from "./previewkit-triggers";

/**
 * Starts the preview deploy/teardown/redeploy lifecycle by launching a
 * Kubernetes Job per operation (apps/previewkit/src/runner), behind the trigger
 * seam. Used by the public `/v1/previewkit/*` router and the GitHub webhook
 * handler; gated by `PREVIEWKIT_ENABLED` at the call sites. Mirrors the diffs
 * wiring in `../diffs/diffs-service.ts`.
 */
const triggers = resolvePreviewkitTriggers();

export const previewkitTriggerService = new PreviewkitTriggerService(
    db,
    new GitHubInstallationService(db, buildGitHubApp(env)),
    createBillingService(db),
    triggers.deploy,
    triggers.teardown,
    triggers.redeployApp,
);
